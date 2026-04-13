// audio.js — Web Audio API sound manager
//
// Engine, shot, and explosion use real samples extracted from original 1988
// Archimedes game footage. Hit, pass-by, ricochet, and incoming remain
// synthesised (no clean isolated samples available).
//
// Sample files: src/audio/engine.ogg, shot.ogg, explosion.ogg
// Loaded via fetch + decodeAudioData on first resume() call.

// ── Shared noise buffer factory (used by synthesised sounds) ──────────────────
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
    this._ctx         = null;
    this._master      = null;

    // Sample buffers (populated on load)
    this._engineBuf   = null;
    this._shotBuf     = null;
    this._explosionBuf= null;
    this._samplesLoaded = false;

    // Engine loop nodes (long-lived)
    this._engineSrc   = null;   // AudioBufferSourceNode, loop=true
    this._engineGain  = null;   // gain: 0 at rest, rises with speed
    this._engineGainTarget = 0; // track last requested gain to avoid glitches
  }

  // ── Initialise context and kick off sample loading ─────────────────────────
  // Must be called from a user-gesture handler (keydown, click, etc.)
  resume() {
    if (!this._ctx) {
      this._ctx    = new (window.AudioContext || window.webkitAudioContext)();
      this._master = this._ctx.createGain();
      this._master.gain.value = 0.70;
      this._master.connect(this._ctx.destination);
      this._loadSamples();
    } else if (this._ctx.state === 'suspended') {
      this._ctx.resume();
    }
  }

  // ── Load OGG samples via fetch ─────────────────────────────────────────────
  async _loadSamples() {
    const base = './audio/';
    const load = async (name) => {
      try {
        const resp = await fetch(base + name);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ab  = await resp.arrayBuffer();
        return await this._ctx.decodeAudioData(ab);
      } catch (e) {
        console.warn(`[audio] failed to load ${name}:`, e);
        return null;
      }
    };

    const [eng, sht, exp] = await Promise.all([
      load('engine.ogg'),
      load('shot.ogg'),
      load('explosion.ogg'),
    ]);

    this._engineBuf    = eng;
    this._shotBuf      = sht;
    this._explosionBuf = exp;
    this._samplesLoaded = true;

    if (this._engineBuf) this._startEngineLoop();
  }

  // ── Start looping engine sample ────────────────────────────────────────────
  // Called once after samples load. The loop runs forever; speed changes only
  // affect gain and playback rate (pitch tracks speed slightly, as with real tracks).
  _startEngineLoop() {
    const ctx = this._ctx;
    const src = ctx.createBufferSource();
    src.buffer    = this._engineBuf;
    src.loop      = true;
    // Skip ~0.1s at each end to avoid any transient edges in the sample
    src.loopStart = 0.15;
    src.loopEnd   = this._engineBuf.duration - 0.15;
    src.playbackRate.value = 0.80;

    const gain = ctx.createGain();
    gain.gain.value = 0.0;   // silent until moving

    src.connect(gain);
    gain.connect(this._master);
    src.start();

    this._engineSrc  = src;
    this._engineGain = gain;
  }

  // ── Engine speed update ────────────────────────────────────────────────────
  // speed: 0..1 normalised (0 = stationary, 1 = full throttle)
  setEngineSpeed(speed) {
    if (!this._ctx || !this._engineGain) return;
    const t = this._ctx.currentTime;

    // Gain: silent at rest, rises with movement
    const targetGain = speed < 0.04 ? 0.0 : 0.10 + speed * 0.55;
    this._engineGain.gain.setTargetAtTime(targetGain, t, 0.10);

    // Playback rate: subtle pitch rise with speed (0.80 idle → 1.20 full)
    // This reproduces the track squeak cadence speeding up organically.
    const rate = 0.80 + speed * 0.40;
    this._engineSrc.playbackRate.setTargetAtTime(rate, t, 0.12);
  }

  // ── Player cannon fire ─────────────────────────────────────────────────────
  playFire() {
    if (!this._ctx) return;
    if (this._shotBuf) {
      this._playOnce(this._shotBuf, 1.0);
    } else {
      this._synthFire();
    }
  }

  // ── Explosion (distance-attenuated) ───────────────────────────────────────
  // distWu: world-unit distance from player to impact
  playExplosion(distWu) {
    if (!this._ctx) return;
    const vol = Math.max(0, 1 - distWu / 175) * 0.90;
    if (vol < 0.015) return;
    if (this._explosionBuf) {
      this._playOnce(this._explosionBuf, vol);
    } else {
      this._synthExplosion(vol);
    }
  }

  // ── Generic one-shot sample playback ──────────────────────────────────────
  _playOnce(buf, volume) {
    const ctx = this._ctx;
    const t   = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(volume, t);
    src.connect(g);
    g.connect(this._master);
    src.start(t);
  }

  // ── Hull hit (shell striking player's tank) — synthesised ─────────────────
  playHit() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;

    const ns  = ctx.createBufferSource();
    ns.buffer = _noiseBuffer(ctx, 0.55);
    const nf  = ctx.createBiquadFilter();
    nf.type            = 'bandpass';
    nf.frequency.value = 1100;
    nf.Q.value         = 1.0;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.55, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.50);

    const osc = ctx.createOscillator();
    osc.type  = 'sine';
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

  // ── Shell pass-by crack/whoosh — synthesised ──────────────────────────────
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

  // ── Ricochet ping — synthesised ───────────────────────────────────────────
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
    nf.type            = 'bandpass';
    nf.frequency.value = 2600;
    nf.Q.value         = 2.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.28, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    ns.connect(nf); nf.connect(ng); ng.connect(this._master);
    ns.start(t); ns.stop(t + 0.22);
  }

  // ── Incoming artillery whistle — synthesised ──────────────────────────────
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

  // ── Synthesised fallbacks (used if samples fail to load) ──────────────────
  _synthFire() {
    const ctx = this._ctx;
    const t   = ctx.currentTime;
    const ns  = ctx.createBufferSource();
    ns.buffer = _noiseBuffer(ctx, 0.18);
    const lpf = ctx.createBiquadFilter();
    lpf.type  = 'bandpass';
    lpf.frequency.value = 200;
    lpf.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(1.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    ns.connect(lpf); lpf.connect(g); g.connect(this._master);
    ns.start(t); ns.stop(t + 0.18);
  }

  _synthExplosion(vol) {
    const ctx = this._ctx;
    const t   = ctx.currentTime;
    const ns  = ctx.createBufferSource();
    ns.buffer = _noiseBuffer(ctx, 1.6);
    const filt = ctx.createBiquadFilter();
    filt.type  = 'lowpass';
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

  get isReady() { return !!this._ctx; }
}
