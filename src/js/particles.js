// particles.js — Muzzle flash and explosion burst effects

import * as THREE from 'three';

const GRAVITY = 9.81;

// ── Single burst of particles ──────────────────────────────────────────────────
class Burst {
  constructor(scene, x, y, z, { count, speed, color, life, size, upBias = 0.4, gravity = GRAVITY, driftX = 0, driftZ = 0 }) {
    this.life    = life;
    this.maxLife = life;
    this.gravity = gravity;
    this.scene   = scene;
    this.count   = count;

    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    this.vel  = new Float32Array(count * 3);

    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >>  8) & 0xff) / 255;
    const b = ((color      ) & 0xff) / 255;

    for (let i = 0; i < count; i++) {
      pos[i*3] = x;  pos[i*3+1] = y;  pos[i*3+2] = z;
      col[i*3] = r;  col[i*3+1] = g;  col[i*3+2] = b;

      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = speed * (0.4 + Math.random() * 0.6);
      this.vel[i*3]   =  Math.sin(ph) * Math.cos(th) * sp + driftX;
      this.vel[i*3+1] =  Math.abs(Math.sin(ph) * Math.sin(th)) * sp + upBias * speed;
      this.vel[i*3+2] =  Math.sin(ph) * Math.cos(th + Math.PI * 0.5) * sp + driftZ;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));

    const mat = new THREE.PointsMaterial({
      size, vertexColors: true, transparent: true, opacity: 1,
      depthWrite: false,
    });

    this.mesh = new THREE.Points(geo, mat);
    this.pos  = pos;
    scene.add(this.mesh);
  }

  update(dt) {
    this.life -= dt;
    this.mesh.material.opacity = Math.max(0, (this.life / this.maxLife) ** 1.5);

    for (let i = 0; i < this.count; i++) {
      this.vel[i*3+1] -= this.gravity * dt;
      this.pos[i*3]   += this.vel[i*3]   * dt;
      this.pos[i*3+1] += this.vel[i*3+1] * dt;
      this.pos[i*3+2] += this.vel[i*3+2] * dt;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    return this.life > 0;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// ── Persistent burning wreck emitter ──────────────────────────────────────────
class Burner {
  constructor(scene, x, y, z) {
    this.scene   = scene;
    this.x = x; this.y = y; this.z = z;
    this._timer  = 0;
    this._bursts = [];
  }

  update(dt) {
    this._timer -= dt;
    if (this._timer <= 0) {
      // Fire flicker
      this._bursts.push(new Burst(this.scene, this.x, this.y, this.z, {
        count: 6, speed: 1.5, color: 0xFF3300, life: 0.9, size: 0.35, upBias: 1.2,
      }));
      // Smoke puff (every other emission)
      if (Math.random() < 0.5) {
        this._bursts.push(new Burst(this.scene, this.x, this.y, this.z, {
          count: 4, speed: 0.7, color: 0x252525, life: 3.0, size: 0.75, upBias: 2.2,
        }));
      }
      this._timer = 0.18 + Math.random() * 0.14;
    }
    for (let i = this._bursts.length - 1; i >= 0; i--) {
      if (!this._bursts[i].update(dt)) {
        this._bursts[i].dispose();
        this._bursts.splice(i, 1);
      }
    }
  }

  dispose() {
    this._bursts.forEach(b => b.dispose());
    this._bursts.length = 0;
  }
}

// ── Persistent light-smoke emitter (damaged but not destroyed tank) ────────────
// intensity: 1 = light damage smoke, 2 = heavy smoke + fire at critical HP
// driftX/driftZ: horizontal lean when tank is moving (opposite to travel direction)
class Smoker {
  constructor(scene, intensity = 1) {
    this.scene     = scene;
    this.x = 0; this.y = 0; this.z = 0;
    this.driftX    = 0;   // horizontal drift velocity (m/s) set each frame by main.js
    this.driftZ    = 0;
    this.active    = true;
    this.intensity = intensity;  // 1 or 2
    this._timer    = 0;
    this._bursts   = [];
  }

  update(dt) {
    this._timer -= dt;
    if (this._timer <= 0 && this.active) {
      if (this.intensity >= 2) {
        // Heavy: thick black smoke + occasional fire — low gravity so column rises
        this._bursts.push(new Burst(this.scene, this.x, this.y, this.z, {
          count: 8, speed: 0.8, color: 0x1A1A1A, life: 3.0, size: 0.90, upBias: 2.5, gravity: 0.4,
          driftX: this.driftX, driftZ: this.driftZ,
        }));
        if (Math.random() < 0.55) {
          this._bursts.push(new Burst(this.scene, this.x, this.y, this.z, {
            count: 4, speed: 1.8, color: 0xFF4400, life: 0.55, size: 0.35, upBias: 1.4, gravity: 0.4,
            driftX: this.driftX, driftZ: this.driftZ,
          }));
        }
        this._timer = 0.25 + Math.random() * 0.2;
      } else {
        // Light: thin grey wisp — low gravity so it rises
        this._bursts.push(new Burst(this.scene, this.x, this.y, this.z, {
          count: 3, speed: 0.5, color: 0x3A3A3A, life: 2.2, size: 0.55, upBias: 1.8, gravity: 0.4,
          driftX: this.driftX, driftZ: this.driftZ,
        }));
        this._timer = 0.5 + Math.random() * 0.4;
      }
    }
    for (let i = this._bursts.length - 1; i >= 0; i--) {
      if (!this._bursts[i].update(dt)) {
        this._bursts[i].dispose();
        this._bursts.splice(i, 1);
      }
    }
  }

  dispose() {
    this._bursts.forEach(b => b.dispose());
    this._bursts.length = 0;
  }
}

// ── Shared mud particle pool ───────────────────────────────────────────────────
// Single BufferGeometry/Points — one draw call for ALL mud particles.
// Dead particles are parked at y = −9999.  frustumCulled = false so the pool
// is never clipped away by the camera bounding-sphere test.
const MUD_GRAVITY = 6;
const MUD_COLORS  = [0x9B7D4A, 0x8B6D3A, 0xAA8D5A, 0x7A5D2A, 0xBB9D6A];

class MudPool {
  constructor(scene, maxParticles = 600) {
    this._max    = maxParticles;
    this._next   = 0;
    this._scene  = scene;

    this._ages   = new Float32Array(maxParticles);
    this._lives  = new Float32Array(maxParticles);
    this._spawnY = new Float32Array(maxParticles);
    this._vel    = new Float32Array(maxParticles * 3);

    const pos = new Float32Array(maxParticles * 3);
    const col = new Float32Array(maxParticles * 3);

    // All slots start dead — parked underground
    for (let i = 0; i < maxParticles; i++) {
      pos[i*3+1]    = -9999;
      this._ages[i] = this._lives[i] = 1;
    }

    const geo = new THREE.BufferGeometry();
    this._posAttr = new THREE.BufferAttribute(pos, 3);
    this._colAttr = new THREE.BufferAttribute(col, 3);
    geo.setAttribute('position', this._posAttr);
    geo.setAttribute('color',    this._colAttr);
    this._pos = pos;
    this._col = col;

    this._mesh = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.2, vertexColors: true, sizeAttenuation: true,
      transparent: true, opacity: 1, depthWrite: false,
    }));
    this._mesh.frustumCulled = false;
    scene.add(this._mesh);
  }

  // Emit a fan of mud chunks. bx/bz: unit vector pointing backward from tank.
  emit(x, y, z, bx = 0, bz = 0) {
    const lx = -bz, lz = bx;   // perpendicular (lateral) direction

    for (let n = 0; n < 6; n++) {
      const i = this._next;
      this._next = (this._next + 1) % this._max;

      const c = MUD_COLORS[Math.floor(Math.random() * MUD_COLORS.length)];
      this._col[i*3]   = ((c >> 16) & 0xff) / 255;
      this._col[i*3+1] = ((c >>  8) & 0xff) / 255;
      this._col[i*3+2] = ( c        & 0xff) / 255;

      this._pos[i*3]   = x + lx * (Math.random() - 0.5) * 1.5;
      this._pos[i*3+1] = y + 0.2;
      this._pos[i*3+2] = z + lz * (Math.random() - 0.5) * 1.5;
      this._spawnY[i]  = y;

      const upV  = 4 + Math.random() * 6;
      const bkV  = 1.0 + Math.random() * 2.0;
      const latV = (Math.random() - 0.5) * 4.0;
      this._vel[i*3]   = bx * bkV + lx * latV;
      this._vel[i*3+1] = upV;
      this._vel[i*3+2] = bz * bkV + lz * latV;

      this._ages[i]  = 0;
      this._lives[i] = 1.2 + Math.random() * 0.8;
    }
    this._colAttr.needsUpdate = true;
  }

  update(dt) {
    for (let i = 0; i < this._max; i++) {
      if (this._ages[i] >= this._lives[i]) continue;

      this._ages[i] += dt;
      if (this._ages[i] >= this._lives[i]) {
        this._pos[i*3+1] = -9999;
        continue;
      }

      this._vel[i*3+1] -= MUD_GRAVITY * dt;
      this._pos[i*3]   += this._vel[i*3]   * dt;
      this._pos[i*3+1] += this._vel[i*3+1] * dt;
      this._pos[i*3+2] += this._vel[i*3+2] * dt;

      if (this._pos[i*3+1] < this._spawnY[i]) {
        this._pos[i*3+1] = this._spawnY[i];
        this._vel[i*3] = this._vel[i*3+1] = this._vel[i*3+2] = 0;
        this._lives[i] = Math.min(this._lives[i], this._ages[i] + 0.3);
      }
    }
    this._posAttr.needsUpdate = true;
  }

  reset() {
    for (let i = 0; i < this._max; i++) {
      this._ages[i] = this._lives[i] = 1;
      this._pos[i*3+1] = -9999;
    }
    this._posAttr.needsUpdate = true;
  }

  dispose() {
    this._scene.remove(this._mesh);
    this._mesh.geometry.dispose();
    this._mesh.material.dispose();
  }
}

// ── Public particle system ─────────────────────────────────────────────────────
export class ParticleSystem {
  constructor(scene) {
    this.scene    = scene;
    this.bursts   = [];
    this._burners = [];   // persistent burning wrecks
    this._smokers = [];   // persistent damage-smoke emitters
    this._mudPool = new MudPool(scene);
  }

  explosion(x, y, z) {
    // Flash — large orange/yellow burst
    this._add(x, y + 0.5, z, { count: 40, speed: 9,  color: 0xFF6600, life: 0.50, size: 0.50, upBias: 0.6 });
    this._add(x, y + 0.5, z, { count: 25, speed: 6,  color: 0xFFAA00, life: 0.40, size: 0.40, upBias: 0.3 });
    this._add(x, y + 0.5, z, { count: 15, speed: 4,  color: 0xFFCC00, life: 0.35, size: 0.30, upBias: 0.2 });
    // Smoke — slow, low gravity, lingers
    this._add(x, y + 0.5, z, { count: 20, speed: 2,  color: 0x555555, life: 3.5,  size: 0.90, upBias: 2.0, gravity: 1.2 });
    this._add(x, y + 0.5, z, { count: 12, speed: 1.5, color: 0x333333, life: 4.5, size: 1.20, upBias: 2.5, gravity: 0.6 });
    // Debris — small dark specks thrown high, fall fast
    this._add(x, y + 0.3, z, { count: 15, speed: 7,  color: 0x222211, life: 1.20, size: 0.15, upBias: 1.5, gravity: 14 });
  }

  mudSpray(x, y, z, bx = 0, bz = 0) {
    this._mudPool.emit(x, y, z, bx, bz);
  }

  // Small wood-chip burst when a tree is destroyed by a tank or shell
  treeBurst(x, y, z) {
    // Splinter chips — brown, kicked in all directions
    this._add(x, y + 1.0, z, { count: 12, speed: 5,  color: 0x664422, life: 0.7,  size: 0.18, upBias: 0.8 });
    // Leaf/canopy fragments — darker green, drift up then fall
    this._add(x, y + 2.0, z, { count: 8,  speed: 3,  color: 0x116622, life: 1.0,  size: 0.22, upBias: 1.0, gravity: 3 });
  }

  muzzleFlash(x, y, z) {
    this._add(x, y, z, { count: 10, speed: 5, color: 0xFFDD00, life: 0.10, size: 0.3, upBias: 0 });
  }

  // Armour deflection — bright gold sparks, no smoke
  ricochet(x, y, z) {
    this._add(x, y, z, { count: 10, speed: 12, color: 0xFFEE66, life: 0.22, size: 0.12, upBias: 0.1 });
  }

  // Start a persistent fire+smoke emitter at a world position (destroyed tank).
  addBurner(x, y, z) {
    this._burners.push(new Burner(this.scene, x, y, z));
  }

  // Create a moveable smoke emitter for a damaged tank. intensity 1=light, 2=heavy+fire.
  addSmoker(intensity = 1) {
    const s = new Smoker(this.scene, intensity);
    this._smokers.push(s);
    return s;
  }

  _add(x, y, z, opts) {
    this.bursts.push(new Burst(this.scene, x, y, z, opts));
  }

  update(dt) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      if (!this.bursts[i].update(dt)) {
        this.bursts[i].dispose();
        this.bursts.splice(i, 1);
      }
    }
    for (const b of this._burners) b.update(dt);
    for (const s of this._smokers) s.update(dt);
    this._mudPool.update(dt);
  }

  dispose() {
    this.bursts.forEach(b => b.dispose());
    this.bursts.length = 0;
    this._burners.forEach(b => b.dispose());
    this._burners.length = 0;
    this._smokers.forEach(s => s.dispose());
    this._smokers.length = 0;
    this._mudPool.reset(); // keep mesh in scene — pool persists across battles
  }
}
