// audio.js — Web Audio API synthesised sound effects
// All sounds are generated procedurally — no audio files required.
// AudioContext is created lazily on the first call to resume() (requires a user gesture).
//
// Engine design informed by spectral analysis of the original 1988 Archimedes game:
//   — No sustained engine drone: original is essentially silent at idle.
//   — Movement: bandpass noise at ~170 Hz, AM-modulated by track-link LFO.
//   — Cannon: bell-curve envelope (~15 ms rise, ~25 ms decay); dominant ~200 Hz.

// ── Shared noise buffer factory ────────────────────────────────────────────────
function _noiseBuffer(ctx, seconds) {
  const len  = Math.ceil(ctx.sampleRate * seconds);
  const buf  = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// ── Audio manager ──────────────────────────────────────────────────────────────
export class AudioManager {
  constructor() {
    this._ctx       = null;
    this._master    = null;
    // Engine voice nodes (long-lived)
    this._ns        = null;   // looped noise source
    this._bpf       = null;   // bandpass shaping track clatter
    this._gMain     = null;   // main gain (AM target)
    this._lfo       = null;   // track-link AM oscillator
    this._lfoScale  = null;   // AM depth
  }

  // Call from a user-gesture handler (keydown etc.) to unlock the AudioContext.
  resume() {
    if (!this._ctx) {
      this._ctx    = new (window.AudioContext || window.webkitAudioContext)();
      this._ctx.resume();
      this._master = this._ctx.createGain();
      this._master.gain.value = 0.55;
      this._master.connect(this._ctx.destination);
      this._startEngine();
    } else if (this._ctx.state === 'suspended') {
      this._ctx.resume();
    }
  }

  // ── Continuous engine voice ────────────────────────────────────────────────
  // Filtered noise AM-modulated at track-link cadence.
  // Silent at idle; rises with speed.  No pitched drone.
  _startEngine() {
    const ctx = this._ctx;

    const ns  = ctx.createBufferSource();
    ns.buffer = _noiseBuffer(ctx, 3.0);
    ns.loop   = true;

    const bpf     = ctx.createBiquadFilter();
    bpf.type      = 'bandpass';
    bpf.frequency.value = 170;
    bpf.Q.value   = 1.8;

    const gMain   = ctx.createGain();
    gMain.gain.value = 0.0;   // silent at rest

    // LFO: AM modulation simulating track-link impacts
    const lfo     = ctx.createOscillator();
    lfo.type      = 'sine';
    lfo.frequency.value = 4;

    const lfoScale = ctx.createGain();
    lfoScale.gain.value = 0.0;

    lfo.connect(lfoScale);
    lfoScale.connect(gMain.gain);

    ns.connect(bpf); bpf.connect(gMain); gMain.connect(this._master);
    ns.start();
    lfo.start();

    this._ns       = ns;
    this._bpf      = bpf;
    this._gMain    = gMain;
    this._lfo      = lfo;
    this._lfoScale = lfoScale;
  }

  // speed: 0..1 normalised (0 = stationary, 1 = full throttle)
  setEngineSpeed(speed) {
    if (!this._ctx) return;
    const t = this._ctx.currentTime;

    // Main gain: silent at rest, rises with movement
    const base = speed < 0.05 ? 0.0 : 0.04 + speed * 0.18;
    this._gMain.gain.setTargetAtTime(base, t, 0.10);

    // BPF centre rises slightly with speed (track link frequency goes up)
    this._bpf.frequency.setTargetAtTime(150 + speed * 100, t, 0.15);

    // LFO rate: 4 Hz idle → 16 Hz full throttle
    this._lfo.frequency.setTargetAtTime(4 + speed * 12, t, 0.15);

    // AM depth: none at rest, deepens with speed
    this._lfoScale.gain.setTargetAtTime(speed * 0.10, t, 0.10);
  }

  // ── Player cannon fire ─────────────────────────────────────────────────────
  // Measured envelope from original: ~15 ms linear rise, ~25 ms exponential fall.
  // Dominant frequency ~200 Hz.  No high-frequency squeak, no sub-bass drone.
  playFire() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;

    const ns  = ctx.createBufferSource();
    ns.buffer = _noiseBuffer(ctx, 0.06);

    const bpf = ctx.createBiquadFilter();
    bpf.type  = 'bandpass';
    bpf.frequency.value = 220;
    bpf.Q.value = 1.4;

    const g   = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(1.1, t + 0.015);    // 15 ms rise (measured)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.040);  // 25 ms fall

    ns.connect(bpf); bpf.connect(g); g.connect(this._master);
    ns.start(t); ns.stop(t + 0.05);
  }

  // ── Explosion (distance-attenuated) ───────────────────────────────────────
  // distWu: world-unit distance from player camera to impact
  playExplosion(distWu) {
    if (!this._ctx) return;
    const vol = Math.max(0, 1 - distWu / 175) * 0.82;
    if (vol < 0.015) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;

    const ns        = ctx.createBufferSource();
    ns.buffer       = _noiseBuffer(ctx, 1.6);
    const filt      = ctx.createBiquadFilter();
    filt.type       = 'lowpass';
    filt.frequency.value = 520;

    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.3);

    // Sub-bass boom
    const sub = ctx.createOscillator();
    sub.type  = 'sine';
    sub.frequency.setValueAtTime(55, t);
    sub.frequency.exponentialRampToValueAtTime(18, t + 0.4);

    const sg = ctx.createGain();
    sg.gain.setValueAtTime(vol * 0.7, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.45);

    ns.connect(filt); filt.connect(g); g.connect(this._master);
    sub.connect(sg); sg.connect(this._master);
    ns.start(t); ns.stop(t + 1.6);
    sub.start(t); sub.stop(t + 0.5);
  }

  // ── Hull hit (shell striking the player's tank) ───────────────────────────
  playHit() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;

    const ns        = ctx.createBufferSource();
    ns.buffer       = _noiseBuffer(ctx, 0.55);
    const nf        = ctx.createBiquadFilter();
    nf.type         = 'bandpass';
    nf.frequency.value = 1100;
    nf.Q.value      = 1.0;

    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.55, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.50);

    const osc  = ctx.createOscillator();
    osc.type   = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.28);

    const og = ctx.createGain();
    og.gain.setValueAtTime(0.45, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.30);

    ns.connect(nf); nf.connect(ng); ng.connect(this._master);
    osc.connect(og); og.connect(this._master);
    ns.start(t); ns.stop(t + 0.55);
    osc.start(t); osc.stop(t + 0.32);
  }

  // ── Shell pass-by crack/whoosh ────────────────────────────────────────────
  playPassby() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;

    const crack = ctx.createOscillator();
    crack.type  = 'sawtooth';
    crack.frequency.setValueAtTime(2200, t);
    crack.frequency.exponentialRampToValueAtTime(340, t + 0.09);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.22, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
    crack.connect(cg); cg.connect(this._master);
    crack.start(t); crack.stop(t + 0.12);

    const ns = ctx.createBufferSource();
    ns.buffer = _noiseBuffer(ctx, 0.30);
    const nf  = ctx.createBiquadFilter();
    nf.type   = 'bandpass';
    nf.frequency.setValueAtTime(3400, t);
    nf.frequency.exponentialRampToValueAtTime(420, t + 0.24);
    nf.Q.value = 1.5;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.16, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    ns.connect(nf); nf.connect(ng); ng.connect(this._master);
    ns.start(t); ns.stop(t + 0.30);
  }

  // ── Ricochet ping ─────────────────────────────────────────────────────────
  playRicochet() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type  = 'sine';
    osc.frequency.setValueAtTime(1800, t);
    osc.frequency.exponentialRampToValueAtTime(380, t + 0.18);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.32, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.20);
    osc.connect(og); og.connect(this._master);
    osc.start(t); osc.stop(t + 0.22);

    const ns = ctx.createBufferSource();
    ns.buffer = _noiseBuffer(ctx, 0.22);
    const nf  = ctx.createBiquadFilter();
    nf.type   = 'bandpass';
    nf.frequency.value = 2600;
    nf.Q.value = 2.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.28, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    ns.connect(nf); nf.connect(ng); ng.connect(this._master);
    ns.start(t); ns.stop(t + 0.22);
  }

  // ── Incoming artillery whistle ─────────────────────────────────────────────
  playIncoming() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type  = 'sine';
    osc.frequency.setValueAtTime(1300, t);
    osc.frequency.exponentialRampToValueAtTime(190, t + 1.7);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.20, t + 1.0);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.85);

    osc.connect(g); g.connect(this._master);
    osc.start(t); osc.stop(t + 1.9);
  }

  get isReady() { return !!this._ctx; }
}
