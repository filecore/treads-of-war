// audio.js — Web Audio API synthesised sound effects
// All sounds are generated procedurally — no audio files required.
// AudioContext is created lazily on the first call to resume() (requires a user gesture).
//
// Engine design from spectral analysis of the original 1988 Archimedes game audio:
//   — Sawtooth-like waveform at 57 Hz CONSTANT (pitch does NOT change with speed).
//   — High harmonics of the sawtooth (9th–10th, ~513–570 Hz) are the audible squeak.
//   — Previous lowpass at 200 Hz was killing those harmonics — removed.
//   — Speed changes only volume and track-link LFO rate (3 Hz idle → 14 Hz max).
//   — Shot: instant onset, dominant 160–280 Hz, ~150 ms decay.

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
    this._osc       = null;   // sawtooth at 57 Hz — constant pitch
    this._lpf       = null;   // mild lowpass (keeps squeak, softens very top)
    this._gMain     = null;   // main gain — AM target, scales with speed
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
  // Sawtooth at 57 Hz — pitch is fixed; speed changes only gain and LFO rate.
  // The 9th–10th harmonics (~513–570 Hz) give the characteristic high squeak.
  // Track-link LFO imposes the rhythmic squeak cadence (3 Hz slow, 14 Hz fast).
  _startEngine() {
    const ctx = this._ctx;

    const osc = ctx.createOscillator();
    osc.type          = 'sawtooth';
    osc.frequency.value = 57;   // constant — never changes

    // Mild lowpass at 2 kHz: softens the very harshest ultra-high harmonics
    // but leaves the audible squeak band (500–700 Hz) fully intact.
    const lpf = ctx.createBiquadFilter();
    lpf.type          = 'lowpass';
    lpf.frequency.value = 2000;
    lpf.Q.value       = 0.5;

    const gMain = ctx.createGain();
    gMain.gain.value  = 0.0;   // silent at rest

    // LFO: audio-rate AM — rhythmic track-link impacts
    const lfo = ctx.createOscillator();
    lfo.type          = 'sine';
    lfo.frequency.value = 3;   // 3 Hz idle

    const lfoScale = ctx.createGain();
    lfoScale.gain.value = 0.0; // no modulation at rest

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

    // Pitch: UNCHANGED — sawtooth stays at 57 Hz regardless of speed.

    // Volume: silent at rest; rises proportionally with movement
    const base = speed < 0.05 ? 0.0 : 0.015 + speed * 0.08;
    this._gMain.gain.setTargetAtTime(base, t, 0.12);

    // Track-link LFO: 3 Hz idle → 14 Hz max (measured from original)
    this._lfo.frequency.setTargetAtTime(3 + speed * 11, t, 0.15);

    // AM depth: none at rest, deepens with speed
    this._lfoScale.gain.setTargetAtTime(speed * 0.07, t, 0.12);
  }

  // ── Player cannon fire ─────────────────────────────────────────────────────
  // Original measured: instant onset (<1 ms), dominant 160–280 Hz, ~150 ms decay.
  playFire() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;

    const ns  = ctx.createBufferSource();
    ns.buffer = _noiseBuffer(ctx, 0.18);

    // Lowpass at 350 Hz covers the 160–280 Hz dominant range of the original
    const lpf = ctx.createBiquadFilter();
    lpf.type  = 'lowpass';
    lpf.frequency.value = 350;
    lpf.Q.value = 1.0;

    const g = ctx.createGain();
    g.gain.setValueAtTime(1.4, t);                          // instant onset
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);  // 150 ms decay

    ns.connect(lpf); lpf.connect(g); g.connect(this._master);
    ns.start(t); ns.stop(t + 0.18);
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
