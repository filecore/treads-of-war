// weather.js — Dynamic weather: fog, sky, particles, AI and movement modifiers
// Single weather type per battle; optional mid-battle transition lerps over 8 seconds.

import * as THREE from 'three';

// ── Per-weather parameters ──────────────────────────────────────────────────────
// fogColor / skyZenith / skyHorizon stored as [R, G, B] byte arrays (absolute).
const PARAMS = {
  clear: {
    fogNear: 300, fogFar: 800,
    fogColor:   [0x9A, 0xB5, 0xC2],
    skyZenith:  [0x33, 0x44, 0x88],
    skyHorizon: [0x9A, 0xB5, 0xC2],
    speedMult: 1.0, detectMult: 1.0, fireIntervalMult: 1.0, engageRangeMult: 1.0,
  },
  rain: {
    fogNear: 150, fogFar: 400,
    fogColor:   [0x5A, 0x65, 0x70],
    skyZenith:  [0x3A, 0x45, 0x50],
    skyHorizon: [0x5A, 0x65, 0x70],
    speedMult: 0.85, detectMult: 0.70, fireIntervalMult: 1.0, engageRangeMult: 1.0,
  },
  fog: {
    // Task 3 tighter values: FOG_NEAR 30, FOG_FAR 140, engage range 40% of normal
    fogNear: 30, fogFar: 140,
    fogColor:   [0x7A, 0x7A, 0x75],
    skyZenith:  [0x6A, 0x6A, 0x65],
    skyHorizon: [0x7A, 0x7A, 0x75],
    speedMult: 1.0, detectMult: 0.35, fireIntervalMult: 1.5, engageRangeMult: 0.40,
  },
  dust: {
    fogNear: 100, fogFar: 350,
    fogColor:   [0x8A, 0x75, 0x40],
    skyZenith:  [0x6A, 0x55, 0x30],
    skyHorizon: [0x8A, 0x75, 0x40],
    speedMult: 0.90, detectMult: 0.60, fireIntervalMult: 1.15, engageRangeMult: 1.0,
  },
};

// Non-clear types that can appear as a secondary simultaneous condition
const NON_CLEAR = ['rain', 'fog', 'dust'];

// Auto-roll probability tables — primary type per battle
const WEATHER_PROBS = {
  arcade:    [['clear', 0.70], ['rain', 0.15], ['fog', 0.10], ['dust', 0.05]],
  attrition: [['clear', 0.50], ['rain', 0.25], ['fog', 0.15], ['dust', 0.10]],
  strategy:  [['clear', 0.40], ['rain', 0.25], ['fog', 0.20], ['dust', 0.15]],
  online:    [['clear', 0.40], ['rain', 0.25], ['fog', 0.20], ['dust', 0.15]],
};

const TRANSITION_SECS = 8;

export const WEATHER_LABELS = {
  clear: 'Clear skies',
  rain:  'Rainy conditions — reduced visibility',
  fog:   'Dense fog — close quarters',
  dust:  'Dust storm — limited visibility',
};

const _CHANGE_IN = {
  clear: 'Weather clearing',
  rain:  'Rain approaching',
  fog:   'Fog rolling in',
  dust:  'Dust storm brewing',
};

function _roll(mode) {
  const table = WEATHER_PROBS[mode] ?? WEATHER_PROBS.arcade;
  const r = Math.random();
  let acc = 0;
  for (const [type, p] of table) {
    acc += p;
    if (r < acc) return type;
  }
  return 'clear';
}

// ── Rain streak pool ──────────────────────────────────────────────────────────
// ~200 thin white vertical streaks in an 80×60×80 wu camera-local volume.
class RainPool {
  constructor(scene) {
    this.scene = scene;
    const N = 200;
    this._n = N;
    const pos = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) {
      pos[i*6]   = (Math.random() - 0.5) * 80;
      pos[i*6+1] = Math.random() * 40;
      pos[i*6+2] = (Math.random() - 0.5) * 80;
      pos[i*6+3] = pos[i*6]   + 0.3;
      pos[i*6+4] = pos[i*6+1] - 2.0;
      pos[i*6+5] = pos[i*6+2];
    }
    const geo = new THREE.BufferGeometry();
    this._attr = new THREE.BufferAttribute(pos, 3);
    geo.setAttribute('position', this._attr);
    this._mat = new THREE.LineBasicMaterial({
      color: 0xCCDDFF, transparent: true, opacity: 0.15, depthWrite: false,
    });
    this._mesh = new THREE.LineSegments(geo, this._mat);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder = 1;
    scene.add(this._mesh);
    this._pos = pos;
  }

  setOpacity(o) { this._mat.opacity = o; }

  update(dt, camera) {
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const FALL = 80, DRIFT = 5;
    const hX = 40, hZ = 40, floorY = -20, ceilY = 30;
    for (let i = 0; i < this._n; i++) {
      this._pos[i*6]   += DRIFT * dt;
      this._pos[i*6+1] -= FALL  * dt;
      this._pos[i*6+3] += DRIFT * dt;
      this._pos[i*6+4] -= FALL  * dt;
      const lx = this._pos[i*6]   - cx;
      const ly = this._pos[i*6+1] - cy;
      const lz = this._pos[i*6+2] - cz;
      if (ly < floorY || Math.abs(lx) > hX || Math.abs(lz) > hZ) {
        const nx = cx + (Math.random() - 0.5) * 80;
        const ny = cy + ceilY * 0.7 + Math.random() * ceilY * 0.3;
        const nz = cz + (Math.random() - 0.5) * 80;
        this._pos[i*6]   = nx;  this._pos[i*6+1] = ny;  this._pos[i*6+2] = nz;
        this._pos[i*6+3] = nx + 0.3;
        this._pos[i*6+4] = ny - 2.0;
        this._pos[i*6+5] = nz;
      }
    }
    this._attr.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this._mesh);
    this._mesh.geometry.dispose();
    this._mat.dispose();
  }
}

// ── Dust streak pool ──────────────────────────────────────────────────────────
// ~150 short horizontal brown streaks drifting with the wind.
class DustPool {
  constructor(scene) {
    this.scene = scene;
    const N = 150;
    this._n = N;
    // Horizontal streaks: 3.0 wu long along drift direction (+X)
    const pos = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) {
      const px = (Math.random() - 0.5) * 80;
      const py = (Math.random() - 0.5) * 12;
      const pz = (Math.random() - 0.5) * 80;
      pos[i*6]   = px;       pos[i*6+1] = py;  pos[i*6+2] = pz;
      pos[i*6+3] = px + 3.0; pos[i*6+4] = py;  pos[i*6+5] = pz;
    }
    const geo = new THREE.BufferGeometry();
    this._attr = new THREE.BufferAttribute(pos, 3);
    geo.setAttribute('position', this._attr);
    // rgba(140, 115, 60, 0.2) → hex colour 0x8C733C
    this._mat = new THREE.LineBasicMaterial({
      color: 0x8C733C, transparent: true, opacity: 0.20, depthWrite: false,
    });
    this._mesh = new THREE.LineSegments(geo, this._mat);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder = 1;
    scene.add(this._mesh);
    this._pos = pos;
  }

  setOpacity(o) { this._mat.opacity = o; }

  update(dt, camera) {
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const DRIFT = 25, FALL = 3;
    for (let i = 0; i < this._n; i++) {
      this._pos[i*6]   += DRIFT * dt;
      this._pos[i*6+1] -= FALL  * dt;
      this._pos[i*6+3] += DRIFT * dt;
      this._pos[i*6+4] -= FALL  * dt;
      const lx = this._pos[i*6]   - cx;
      const ly = this._pos[i*6+1] - cy;
      const lz = this._pos[i*6+2] - cz;
      if (ly < -10 || Math.abs(lx) > 40 || Math.abs(lz) > 40) {
        const nx = cx - 40 + Math.random() * 5;
        const ny = cy - 5 + Math.random() * 12;
        const nz = cz + (Math.random() - 0.5) * 80;
        this._pos[i*6]   = nx;       this._pos[i*6+1] = ny;  this._pos[i*6+2] = nz;
        this._pos[i*6+3] = nx + 3.0; this._pos[i*6+4] = ny;  this._pos[i*6+5] = nz;
      }
    }
    this._attr.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this._mesh);
    this._mesh.geometry.dispose();
    this._mat.dispose();
  }
}

// ── WeatherManager ────────────────────────────────────────────────────────────
// One weather type per battle. Mid-battle transition lerps all parameters over
// TRANSITION_SECS seconds. Particles fade in/out proportionally.
export class WeatherManager {
  constructor(scene) {
    this._scene      = scene;
    this._current    = 'clear';   // active type
    this._next       = null;      // incoming type during mid-battle transition
    this._transT     = 0;         // 0→1 transition progress
    this._forced     = null;      // null = auto roll; string = force that type
    this._rain       = null;
    this._dust       = null;
    this._secondary  = null;   // optional second simultaneous condition (non-clear)
    this._camera     = null;
    this._pendingMsg = null;
    this._skyDirty   = true;
    this._battleTime = 0;
    this._changeAt   = Infinity;
    this._changed    = false;
  }

  // Returns dominant visible type
  get current() { return this._next && this._transT > 0.5 ? this._next : this._current; }

  setCamera(cam) { this._camera = cam; }

  // type: null or 'auto' = auto roll; 'clear'/'rain'/'fog'/'dust' = force that type
  setForced(type) {
    this._forced = (!type || type === 'auto') ? null : type;
  }

  // Call at battle start. Returns { weather, label }.
  init(mode, estimatedDuration = 120) {
    this._disposeParticles();
    this._battleTime = 0;
    this._changed    = false;
    this._pendingMsg = null;
    this._next       = null;
    this._transT     = 0;
    this._secondary  = null;

    const type = (this._forced && this._forced !== 'auto') ? this._forced : _roll(mode);
    this._current = type;

    // Optionally roll a second simultaneous non-clear condition (auto mode only)
    if (!this._forced && type !== 'clear' && Math.random() < 0.40) {
      const candidates = NON_CLEAR.filter(t => t !== type);
      this._secondary = candidates[Math.floor(Math.random() * candidates.length)];
    }

    // Spawn initial particles immediately (full opacity — no fade-in at start)
    if (type === 'rain' || this._secondary === 'rain') this._rain = new RainPool(this._scene);
    if (type === 'dust' || this._secondary === 'dust') this._dust = new DustPool(this._scene);

    // 50% chance of one mid-battle change (primary only; secondary persists throughout)
    if (!this._forced && !this._secondary && Math.random() < 0.5) {
      const lo = estimatedDuration * 0.30;
      const hi = estimatedDuration * 0.70;
      this._changeAt = lo + Math.random() * (hi - lo);
    } else {
      this._changeAt = Infinity;
    }

    this.markSkyDirty();
    const label = this._secondary
      ? `${WEATHER_LABELS[type]} + ${WEATHER_LABELS[this._secondary].split('—')[0].trim()}`
      : (WEATHER_LABELS[type] ?? type);
    return { weather: type, label };
  }

  update(dt) {
    this._battleTime += dt;

    // Trigger mid-battle weather change
    if (!this._changed && this._battleTime >= this._changeAt) {
      this._changed = true;
      let next = _roll('strategy');
      let attempts = 0;
      while (next === this._current && attempts++ < 8) next = _roll('strategy');
      this._next   = next;
      this._transT = 0;
      // Spawn incoming particles early so they fade in
      if (next === 'rain' && !this._rain) this._rain = new RainPool(this._scene);
      if (next === 'dust' && !this._dust) this._dust = new DustPool(this._scene);
      this._pendingMsg = _CHANGE_IN[next] ?? `Weather changing`;
    }

    // Advance transition
    if (this._next !== null) {
      this._transT += dt / TRANSITION_SECS;
      if (this._transT >= 1) {
        this._transT = 1;
        const old = this._current;
        this._current = this._next;
        this._next    = null;
        this._transT  = 0;
        // Dispose outgoing particles (keep alive if secondary still needs them)
        if (old !== this._current) {
          if (old === 'rain' && this._secondary !== 'rain' && this._rain) { this._rain.dispose(); this._rain = null; }
          if (old === 'dust' && this._secondary !== 'dust' && this._dust) { this._dust.dispose(); this._dust = null; }
        }
      }
      this.markSkyDirty();
    }

    // Update particle opacity (fade in/out with transition) and positions
    if (this._camera) {
      if (this._rain) {
        const t = this._next === 'rain'
          ? this._transT
          : (this._current === 'rain' && this._next !== null ? 1 - this._transT : 1);
        this._rain.setOpacity(0.15 * t);
        this._rain.update(dt, this._camera);
      }
      if (this._dust) {
        const t = this._next === 'dust'
          ? this._transT
          : (this._current === 'dust' && this._next !== null ? 1 - this._transT : 1);
        this._dust.setOpacity(0.20 * t);
        this._dust.update(dt, this._camera);
      }
    }
  }

  // Apply current (lerped) fog and sky to the scene.
  applyToScene(sceneFog, skyGeo) {
    const a = PARAMS[this._current] ?? PARAMS.clear;
    const b = this._next ? PARAMS[this._next] : null;
    const t = this._transT;
    const lerp = (x, y) => b !== null ? x + (y - x) * t : x;
    const s = this._secondary ? PARAMS[this._secondary] : null;   // secondary condition

    // Fog: tightest near/far wins when secondary is active
    const fogNear = s ? Math.min(lerp(a.fogNear, b?.fogNear ?? a.fogNear), s.fogNear) : lerp(a.fogNear, b?.fogNear ?? a.fogNear);
    const fogFar  = s ? Math.min(lerp(a.fogFar,  b?.fogFar  ?? a.fogFar),  s.fogFar)  : lerp(a.fogFar,  b?.fogFar  ?? a.fogFar);
    sceneFog.near = fogNear;
    sceneFog.far  = fogFar;

    const fc = a.fogColor.map((v, i) => {
      const pv = lerp(v, b ? b.fogColor[i] : v);
      return s ? (pv + s.fogColor[i]) / 2 : pv;
    });
    sceneFog.color.setRGB(
      Math.max(0, Math.min(255, fc[0])) / 255,
      Math.max(0, Math.min(255, fc[1])) / 255,
      Math.max(0, Math.min(255, fc[2])) / 255,
    );

    if (this._skyDirty) {
      this._skyDirty = false;
      const colAttr = skyGeo.getAttribute('color');
      const skyR    = skyGeo.parameters?.radius ?? 1;
      const zc = a.skyZenith.map((v, i)  => {
        const pv = lerp(v, b ? b.skyZenith[i]  : v);
        return s ? (pv + s.skyZenith[i])  / 2 : pv;
      });
      const hc = a.skyHorizon.map((v, i) => {
        const pv = lerp(v, b ? b.skyHorizon[i] : v);
        return s ? (pv + s.skyHorizon[i]) / 2 : pv;
      });
      const czR = zc.map(v => Math.max(0, Math.min(255, v)));
      const chR = hc.map(v => Math.max(0, Math.min(255, v)));
      const cnt = colAttr.count;
      for (let i = 0; i < cnt; i++) {
        const y     = skyGeo.attributes.position.getY(i);
        const blend = Math.max(0, Math.min(1, y / skyR));
        colAttr.setXYZ(i,
          (chR[0] + (czR[0] - chR[0]) * blend) / 255,
          (chR[1] + (czR[1] - chR[1]) * blend) / 255,
          (chR[2] + (czR[2] - chR[2]) * blend) / 255,
        );
      }
      colAttr.needsUpdate = true;
    }
  }

  // Generic lerp helper for scalar multipliers; secondary condition stacks on top
  _getMult(prop) {
    const a = PARAMS[this._current]?.[prop] ?? 1.0;
    const primary = this._next
      ? a + ((PARAMS[this._next]?.[prop] ?? 1.0) - a) * this._transT
      : a;
    if (!this._secondary) return primary;
    const s = PARAMS[this._secondary]?.[prop] ?? 1.0;
    // Fire interval: take the worse (higher) value; all others: multiply penalties
    return prop === 'fireIntervalMult' ? Math.max(primary, s) : primary * s;
  }

  getSpeedMultiplier()        { return this._getMult('speedMult'); }
  getDetectionMultiplier()    { return this._getMult('detectMult'); }
  getFireIntervalMultiplier() { return this._getMult('fireIntervalMult'); }
  getEngageRangeMultiplier()  { return this._getMult('engageRangeMult'); }

  consumeMessage() { const m = this._pendingMsg; this._pendingMsg = null; return m; }
  markSkyDirty()   { this._skyDirty = true; }

  _disposeParticles() {
    if (this._rain) { this._rain.dispose(); this._rain = null; }
    if (this._dust) { this._dust.dispose(); this._dust = null; }
  }

  dispose() { this._disposeParticles(); }
}
