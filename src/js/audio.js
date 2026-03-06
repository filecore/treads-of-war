// audio.js — Web Audio API synthesised sound effects
// All sounds are generated procedurally — no audio files required.
// AudioContext is created lazily on the first call to resume() (requires a user gesture).

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
    this._engOsc    = null;
    this._engGain   = null;
    this._engFilter = null;
    this._noiseGain = null;
  }

  // Call from a user-gesture handler (keydown etc.) to unlock the AudioContext.
  resume() {
    if (!this._ctx) {
      this._ctx    = new (window.AudioContext || window.webkitAudioContext)();
      this._master = this._ctx.createGain();
      this._master.gain.value = 0.55;
      this._master.connect(this._ctx.destination);
      this._startEngine();
    } else if (this._ctx.state === 'suspended') {
      this._ctx.resume();
    }
  }

  // ── Continuous engine voice ────────────────────────────────────────────────
  _startEngine() {
    const ctx = this._ctx;

    // Sawtooth oscillator for diesel rumble
    const osc   = ctx.createOscillator();
    osc.type    = 'sawtooth';
    osc.frequency.value = 50;

    const filt  = ctx.createBiquadFilter();
    filt.type   = 'lowpass';
    filt.frequency.value = 280;
    filt.Q.value = 0.8;

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.08;

    osc.connect(filt);
    filt.connect(oscGain);
    oscGain.connect(this._master);
    osc.start();

    // Looping noise layer for track rattle
    const noiseSrc        = ctx.createBufferSource();
    noiseSrc.buffer       = _noiseBuffer(ctx, 2.0);
    noiseSrc.loop         = true;

    const noiseFilt       = ctx.createBiquadFilter();
    noiseFilt.type        = 'bandpass';
    noiseFilt.frequency.value = 220;
    noiseFilt.Q.value     = 1.2;

    const noiseGain       = ctx.createGain();
    noiseGain.gain.value  = 0.0;   // silent until moving

    noiseSrc.connect(noiseFilt);
    noiseFilt.connect(noiseGain);
    noiseGain.connect(this._master);
    noiseSrc.start();

    this._engOsc    = osc;
    this._engGain   = oscGain;
    this._engFilter = filt;
    this._noiseGain = noiseGain;
  }

  // speed: 0..1 normalised (0 = stationary, 1 = full throttle)
  setEngineSpeed(speed) {
    if (!this._ctx) return;
    const t = this._ctx.currentTime;
    // Pitch: 48 Hz idle → 155 Hz at full throttle
    this._engOsc.frequency.setTargetAtTime(48 + speed * 107, t, 0.08);
    // Volume: quiet idle rumble, louder under load
    this._engGain.gain.setTargetAtTime(0.07 + speed * 0.11, t, 0.06);
    this._noiseGain.gain.setTargetAtTime(speed * 0.055, t, 0.05);
    // Filter cutoff rises a little with speed (brighter sound)
    this._engFilter.frequency.setTargetAtTime(240 + speed * 200, t, 0.1);
  }

  // ── Player cannon fire ─────────────────────────────────────────────────────
  playFire() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;

    // Low-frequency thud
    const osc = ctx.createOscillator();
    osc.type  = 'sine';
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(22, t + 0.28);

    const og = ctx.createGain();
    og.gain.setValueAtTime(0.60, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.30);

    osc.connect(og);
    og.connect(this._master);
    osc.start(t); osc.stop(t + 0.32);

    // Noise blast
    const ns        = ctx.createBufferSource();
    ns.buffer       = _noiseBuffer(ctx, 0.35);
    const nf        = ctx.createBiquadFilter();
    nf.type         = 'lowpass';
    nf.frequency.value = 900;

    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.65, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.28);

    ns.connect(nf); nf.connect(ng); ng.connect(this._master);
    ns.start(t); ns.stop(t + 0.35);
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
  // Plays when an enemy shell flies close — sharp Doppler crack + descending whoosh.
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

    // Whoosh: bandpass noise sweeping down in frequency
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
  // Distinct metallic spark-ping — higher and brighter than the hull-hit thud.
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
  // Descending tone simulating a shell screaming in — plays on barrage call,
  // peaks just as the first explosion lands (~1.8 s later).
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
