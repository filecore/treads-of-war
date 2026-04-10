// audio.js — Web Audio API synthesised sound effects
// All sounds are generated procedurally — no audio files required.
// AudioContext is created lazily on the first call to resume() (requires a user gesture).
//
// Engine design is based on spectral analysis of the original Archimedes game:
//   — Idle engine: ~55 Hz fundamental (pitched looped sample), rises to ~210 Hz at speed.
//   — Track-link AM modulation: ~3.5 Hz at idle, up to ~15 Hz at full throttle.
//   — Cannon shot: very percussive (~10 ms body), dominant ~200 Hz, no deep sub-bass.

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
    this._osc       = null;   // sawtooth oscillator — pitch scales with speed
    this._lpf       = null;   // lowpass shaping harmonics
    this._gMain     = null;   // main engine gain (AM target)
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
  // Sawtooth oscillator whose pitch tracks tank speed, amplitude-modulated by
  // a low-frequency oscillator simulating rhythmic track-link impacts.
  // Based on measured original: 55 Hz at idle → ~210 Hz at full throttle.
  // Track-link rate: 3.5 Hz idle → ~15 Hz full throttle.
  _startEngine() {
    const ctx = this._ctx;

    // Sawtooth oscillator — rich harmonics mimic the original's looped sample
    const osc = ctx.createOscillator();
    osc.type          = 'sawtooth';
    osc.frequency.value = 55;   // idle pitch

    // Lowpass shapes the harmonic stack: passes fundamental + 2–3 overtones
    const lpf = ctx.createBiquadFilter();
    lpf.type          = 'lowpass';
    lpf.frequency.value = 220;  // just above 4th harmonic at idle
    lpf.Q.value       = 0.8;

    const gMain = ctx.createGain();
    gMain.gain.value  = 0.04;   // quiet at rest

    // LFO: audio-rate AM — gain sums with the base value
    const lfo = ctx.createOscillator();
    lfo.type          = 'sine';
    lfo.frequency.value = 3.5;  // ~3.5 Hz measured at idle

    const lfoScale = ctx.createGain();
    lfoScale.gain.value = 0.0;  // no modulation at rest

    lfo.connect(lfoScale);
    lfoScale.connect(gMain.gain);

    osc.connect(lpf); lpf.connect(gMain); gMain.connect(this._master);
    osc.start();
    lfo.start();

    this._osc      = osc;
    this._lpf      = lpf;
    this._gMain    = gMain;
    this._lfo      = lfo;
    this._lfoScale = lfoScale;
  }

  // speed: 0..1 normalised (0 = stationary, 1 = full throttle)
  setEngineSpeed(speed) {
    if (!this._ctx) return;
    const t = this._ctx.currentTime;

    // Pitch: 55 Hz idle → 210 Hz full speed (matches original spectral analysis)
    this._osc.frequency.setTargetAtTime(55 + speed * 155, t, 0.25);

    // LPF opens as engine revs — preserves character at all speeds
    this._lpf.frequency.setTargetAtTime(200 + speed * 500, t, 0.20);

    // Main gain: soft at rest, louder when moving
    const base = 0.03 + speed * 0.12;
    this._gMain.gain.setTargetAtTime(base, t, 0.12);

    // Track-link LFO: 3.5 Hz idle → 15 Hz full throttle
    this._lfo.frequency.setTargetAtTime(3.5 + speed * 11.5, t, 0.18);

    // AM depth: no modulation at rest, deepens with speed
    this._lfoScale.gain.setTargetAtTime(speed * 0.08, t, 0.12);
  }

  // ── Player cannon fire ─────────────────────────────────────────────────────
  // Original is extremely percussive (~10 ms body), dominant ~200 Hz.
  // Sawtooth burst through a bandpass, plus a brief highpass crack.
  // No long sub-bass component — that was causing the "champagne pop" effect.
  playFire() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;

    // Initial crack: very brief highpass noise burst
    const ns1 = ctx.createBufferSource();
    ns1.buffer = _noiseBuffer(ctx, 0.02);
    const nf1  = ctx.createBiquadFilter();
    nf1.type   = 'highpass';
    nf1.frequency.value = 2200;
    const ng1  = ctx.createGain();
    ng1.gain.setValueAtTime(0.9, t);
    ng1.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
    ns1.connect(nf1); nf1.connect(ng1); ng1.connect(this._master);
    ns1.start(t); ns1.stop(t + 0.02);

    // Shot body: sawtooth pitch-drops through bandpass at ~200 Hz
    // Matches original's measured dominant frequency at shot onset
    const osc = ctx.createOscillator();
    osc.type  = 'sawtooth';
    osc.frequency.setValueAtTime(70, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.08);
    const bpf = ctx.createBiquadFilter();
    bpf.type  = 'bandpass';
    bpf.frequency.value = 210;
    bpf.Q.value = 0.7;
    const og  = ctx.createGain();
    og.gain.setValueAtTime(0.0, t);
    og.gain.linearRampToValueAtTime(1.3, t + 0.003);    // 3 ms attack
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);  // fast decay
    osc.connect(bpf); bpf.connect(og); og.connect(this._master);
    osc.start(t); osc.stop(t + 0.09);
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

    // Metallic clang: bandpass noise
    const ns        = ctx.createBufferSource();
    ns.buffer       = _noiseBuffer(ctx, 0.55);
    const nf        = ctx.createBiquadFilter();
    nf.type         = 'bandpass';
    nf.frequency.value = 1100;
    nf.Q.value      = 1.0;

    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.55, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.50);

    // Low impact thud
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

    // Sharp crack: sawtooth burst dropping fast
    const crack = ctx.createOscillator();
    crack.type  = 'sawtooth';
    crack.frequency.setValueAtTime(2200, t);
    crack.frequency.exponentialRampToValueAtTime(340, t + 0.09);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.22, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
    crack.connect(cg); cg.connect(this._master);
    crack.start(t); crack.stop(t + 0.12);

    // Whoosh: bandpass noise sweeping down
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
