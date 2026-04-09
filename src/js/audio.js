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
    this._ctx        = null;
    this._master     = null;
    // Engine voice nodes (long-lived)
    this._engOsc     = null;
    this._engGain    = null;
    this._engFilter  = null;
    this._noiseGain  = null;   // low metallic crunch
    this._squeakGain = null;   // high-frequency track squeak
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
  // Two noise layers give the "uneven squeak of wheels and metal tracks":
  //   low crunch  (350 Hz bandpass) — heavy metallic grinding
  //   high overtone (~700 Hz bandpass) — matches shorter-period waveform in original
  _startEngine() {
    const ctx = this._ctx;

    // Diesel drone — very low sawtooth, heavily low-passed
    const osc  = ctx.createOscillator();
    osc.type   = 'sawtooth';
    osc.frequency.value = 28;   // deep diesel idle

    const filt = ctx.createBiquadFilter();
    filt.type  = 'lowpass';
    filt.frequency.value = 100;
    filt.Q.value = 0.5;

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.05;

    osc.connect(filt);
    filt.connect(oscGain);
    oscGain.connect(this._master);
    osc.start();

    // Shared noise source — split into two filtered paths
    const ns  = ctx.createBufferSource();
    ns.buffer = _noiseBuffer(ctx, 2.0);
    ns.loop   = true;

    // Low metallic crunch: heavy grinding / track links hitting sprocket
    const nf1 = ctx.createBiquadFilter();
    nf1.type  = 'bandpass';
    nf1.frequency.value = 350;
    nf1.Q.value = 2.5;

    const ng1 = ctx.createGain();
    ng1.gain.value = 0.0;

    ns.connect(nf1); nf1.connect(ng1); ng1.connect(this._master);

    // Higher metallic overtone: ~700 Hz — original buffer 0 is ~27-sample period
    const nf2 = ctx.createBiquadFilter();
    nf2.type  = 'bandpass';
    nf2.frequency.value = 700;
    nf2.Q.value = 3.0;

    const ng2 = ctx.createGain();
    ng2.gain.value = 0.0;

    ns.connect(nf2); nf2.connect(ng2); ng2.connect(this._master);
    ns.start();

    this._engOsc     = osc;
    this._engGain    = oscGain;
    this._engFilter  = filt;
    this._noiseGain  = ng1;
    this._squeakGain = ng2;
  }

  // speed: 0..1 normalised (0 = stationary, 1 = full throttle)
  setEngineSpeed(speed) {
    if (!this._ctx) return;
    const t = this._ctx.currentTime;
    // Diesel pitch: 28 Hz idle → 65 Hz at full throttle
    this._engOsc.frequency.setTargetAtTime(28 + speed * 37, t, 0.12);
    // Rumble volume: always present, mild rise under load
    this._engGain.gain.setTargetAtTime(0.04 + speed * 0.03, t, 0.08);
    // Low metallic crunch: rises linearly with speed
    this._noiseGain.gain.setTargetAtTime(speed * 0.08, t, 0.06);
    // High squeak: only audible above 30% throttle, then rises quickly
    this._squeakGain.gain.setTargetAtTime(Math.max(0, speed - 0.3) * 0.045, t, 0.05);
    // Filter tracks speed slightly
    this._engFilter.frequency.setTargetAtTime(80 + speed * 60, t, 0.12);
  }

  // ── Player cannon fire ─────────────────────────────────────────────────────
  // Three layers: sub-bass cannon thud + muffled concussion + brief propellant crack
  playFire() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;

    // Sub-bass cannon thud — deep sine dropping from 55 Hz to 18 Hz
    const boom = ctx.createOscillator();
    boom.type  = 'sine';
    boom.frequency.setValueAtTime(55, t);
    boom.frequency.exponentialRampToValueAtTime(18, t + 0.5);

    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.95, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.55);

    boom.connect(bg); bg.connect(this._master);
    boom.start(t); boom.stop(t + 0.6);

    // Muffled concussion wave — lowpass noise, heavy air-pressure feel
    const ns1 = ctx.createBufferSource();
    ns1.buffer = _noiseBuffer(ctx, 0.6);
    const nf1  = ctx.createBiquadFilter();
    nf1.type   = 'lowpass';
    nf1.frequency.value = 320;

    const ng1 = ctx.createGain();
    ng1.gain.setValueAtTime(0.75, t);
    ng1.gain.exponentialRampToValueAtTime(0.001, t + 0.5);

    ns1.connect(nf1); nf1.connect(ng1); ng1.connect(this._master);
    ns1.start(t); ns1.stop(t + 0.6);

    // Sharp propellant crack — very brief highpass burst
    const ns2 = ctx.createBufferSource();
    ns2.buffer = _noiseBuffer(ctx, 0.06);
    const nf2  = ctx.createBiquadFilter();
    nf2.type   = 'highpass';
    nf2.frequency.value = 3000;

    const ng2 = ctx.createGain();
    ng2.gain.setValueAtTime(0.30, t);
    ng2.gain.exponentialRampToValueAtTime(0.001, t + 0.05);

    ns2.connect(nf2); nf2.connect(ng2); ng2.connect(this._master);
    ns2.start(t); ns2.stop(t + 0.07);
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
