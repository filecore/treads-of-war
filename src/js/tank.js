// tank.js — Tank model, dual-track physics, terrain orientation, third-person camera

import * as THREE from 'three';
import { CONFIG }              from './config.js';
import { getAltitude }         from './terrain.js';
import { buildAuthenticModel } from './models.js';

// ── Physics scaling ────────────────────────────────────────────────────────────
// Tank stat values (0–100 range) are scaled to world units per second.
const SPEED_SCALE = 0.20;    // stat 55 → 11.0 wu/s  (Sherman)
const ACCEL_SCALE = 0.15;    // stat 40 →  6.0 wu/s²  (snappier acceleration)
// Turn rate: diffSpeed (wu/s) × turnRate_stat × TURN_SCALE = yaw rad/s
// Tuned so Sherman (turnRate=50) with one track stopped does ~4s per circle
const TURN_SCALE  = 0.003;

// Terrain-normal sampling epsilon (world units)
const NORM_EPS = 2;

// Cross-country speed: slope thresholds for road→XC blend
// At gradient ≤ SLOPE_FLAT the tank runs at full road speed.
// At gradient ≥ SLOPE_MAX  the tank is fully limited to XC speed.
// (Fourier terrain typical range: flat ~0.02, moderate hill ~0.10, steep ~0.25+)
const SLOPE_EPS  = 4;     // world-unit sampling radius for slope detection
const SLOPE_FLAT = 0.03;  // gradient below this → road speed
const SLOPE_MAX  = 0.20;  // gradient above this → full XC speed penalty

// Third-person camera
const CAM_BEHIND   = 25;    // units behind tank
const CAM_UP       = 12;    // units above terrain
const CAM_LAG      = 0.03;  // position lerp per frame — lower = more lag
const CAM_LOOK_LAG = 0.05;  // look-at lerp per frame
const CAM_HEAD_LAG = 0.025; // camera heading lag — prevents wild swinging on turns


// ── Temp vectors (reused each frame to avoid GC) ───────────────────────────────
const _norm    = new THREE.Vector3();
const _fwdAdj  = new THREE.Vector3();
const _right   = new THREE.Vector3();
const _up      = new THREE.Vector3(0, 1, 0);
const _basis   = new THREE.Matrix4();
const _qTarget = new THREE.Quaternion();

// Camera lerp targets
const _camTarget = new THREE.Vector3();
const _lookAt    = new THREE.Vector3();

// ── Tank class ─────────────────────────────────────────────────────────────────
export class Tank {
  constructor(scene, defKey = 'sherman', isEnemy = false) {
    this.def    = CONFIG.TANK_DEFS[defKey];
    this.defKey = defKey;

    // Derived physics values
    this.maxSpeed = this.def.maxSpeed * SPEED_SCALE;   // wu/s  (road speed)
    this.xcSpeed  = this.def.xcSpeed  * SPEED_SCALE;   // wu/s  (cross-country speed)
    this.accel    = this.def.accel    * ACCEL_SCALE;   // wu/s²
    this.turnRate = this.def.turnRate * TURN_SCALE;    // rad/s at full differential

    // State
    this.heading      = 0;     // radians, Y-axis (0 = −Z = forward in Three.js)
    this.leftSpeed    = 0;     // wu/s (signed)
    this.rightSpeed   = 0;     // wu/s (signed)
    this.turretYaw    = 0;     // radians relative to hull
    this.gunElevation = 0.06;  // radians — overridden by ballistic solver when aim assist active
    this.reloadTime   = this.def.reloadTime;  // may be overridden per-instance (e.g. player bonus)
    this.reloadTimer  = this.reloadTime;      // starts ready to fire

    // HP / damage state
    this.maxHp           = 100;
    this.hp              = 100;
    this.alive           = true;
    this.damageMult      = 1.0;   // set by difficulty system for the player tank
    this.turretSpeedMult = 1.0;   // set to 1.05 for player
    this.roadBonus       = false; // set each frame by main.js; suppresses XC slope penalty

    this.position = new THREE.Vector3(0, 0, 0);

    // Build authentic model from original Archimedes vertex data
    const built = buildAuthenticModel(this.def, defKey, isEnemy);
    this.mesh         = built.grp;
    this.turretGroup  = built.turretGroup;
    this._hitRadius   = built.hitRadius;
    this.muzzleDist   = built.muzzleDist;
    this.muzzleHeight = built.muzzleHeight;
    scene.add(this.mesh);

    // Place on terrain at spawn
    this.position.y = getAltitude(0, 0) + 0.1;
    this.mesh.position.copy(this.position);

    // Camera lag state
    this._camPos     = new THREE.Vector3();
    this._camLook    = new THREE.Vector3();
    this._camHeading = 0;   // smoothed heading used for camera placement
    this._camInit    = false;
  }

  // ── Per-frame update ──────────────────────────────────────────────────────────
  update(dt, input) {
    const def = this.def;
    const a   = this.accel;
    // HP-based speed penalty: half speed below 50%, quarter below 25%, immobile below 12%
    if (this.hp < 12) { this.leftSpeed = 0; this.rightSpeed = 0; }
    const hpMod = this.hp < 25 ? 0.25 : this.hp < 50 ? 0.5 : 1.0;
    // Cross-country speed: blend road↔XC based on terrain gradient at current pos
    const px0  = this.position.x, pz0 = this.position.z;
    const gx   = (getAltitude(px0 + SLOPE_EPS, pz0) - getAltitude(px0 - SLOPE_EPS, pz0)) / (2 * SLOPE_EPS);
    const gz   = (getAltitude(px0, pz0 + SLOPE_EPS) - getAltitude(px0, pz0 - SLOPE_EPS)) / (2 * SLOPE_EPS);
    const rawSlope    = Math.min(1, Math.max(0, (Math.sqrt(gx * gx + gz * gz) - SLOPE_FLAT) / (SLOPE_MAX - SLOPE_FLAT)));
    const slopeFactor = this.roadBonus ? 0 : rawSlope;  // roads are graded — ignore slope penalty
    const max  = (this.maxSpeed + (this.xcSpeed - this.maxSpeed) * slopeFactor) * hpMod;
    const fri  = CONFIG.FRICTION;
    // Clamp existing track speeds to new effective max (e.g. entering steep slope)
    this.leftSpeed  = Math.max(-max, Math.min(max,  this.leftSpeed));
    this.rightSpeed = Math.max(-max, Math.min(max, this.rightSpeed));

    // ── Track acceleration ────────────────────────────────────────────────────
    if (input.skipAccel) {
      // AI-driven: speeds already set by controller — just clamp to current effective max
      this.leftSpeed  = Math.max(-max, Math.min(max, this.leftSpeed));
      this.rightSpeed = Math.max(-max, Math.min(max, this.rightSpeed));
    } else {
      const leftFwd  = input.leftFwd;
      const leftBwd  = input.leftBwd;
      const rightFwd = input.rightFwd;
      const rightBwd = input.rightBwd;

      if (leftFwd)       this.leftSpeed  = Math.min(this.leftSpeed  + a * dt, max);
      else if (leftBwd)  this.leftSpeed  = Math.max(this.leftSpeed  - a * dt, -max);
      else               this.leftSpeed *= Math.pow(fri, dt * 60);   // frame-rate-independent friction

      if (rightFwd)      this.rightSpeed = Math.min(this.rightSpeed + a * dt, max);
      else if (rightBwd) this.rightSpeed = Math.max(this.rightSpeed - a * dt, -max);
      else               this.rightSpeed *= Math.pow(fri, dt * 60);

      // ── Track equalization ──────────────────────────────────────────────────
      // When both tracks driven the same direction, pull speeds together quickly.
      // Prevents arc persistence when re-applying a track after releasing it.
      if ((leftFwd && rightFwd) || (leftBwd && rightBwd)) {
        const avg = (this.leftSpeed + this.rightSpeed) * 0.5;
        this.leftSpeed  += (avg - this.leftSpeed)  * Math.min(8 * dt, 1);
        this.rightSpeed += (avg - this.rightSpeed) * Math.min(8 * dt, 1);
      }
    }

    // ── Yaw from differential ─────────────────────────────────────────────────
    const avgSpeed  = (this.leftSpeed + this.rightSpeed) * 0.5;
    const diffSpeed = this.rightSpeed - this.leftSpeed;
    this.heading   += diffSpeed * this.turnRate * dt;

    // ── Move along heading ─────────────────────────────────────────────────────
    // In Three.js, −Z is the canonical "forward" direction.
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    this.position.x += -sinH * avgSpeed * dt;
    this.position.z += -cosH * avgSpeed * dt;

    // ── Terrain hug (multi-point to prevent hull clipping on slopes) ───────────
    // A rigid body rests on the highest combination of front/rear/side contact
    // points — same as a physical tank hull sitting on uneven ground.
    const px = this.position.x;
    const pz = this.position.z;
    const s  = def.modelScale;
    const hL = 1.9  * s;   // half track length
    const hW = 1.05 * s;   // half track width
    const altF  = getAltitude(px - sinH * hL,  pz - cosH * hL);   // front
    const altR  = getAltitude(px + sinH * hL,  pz + cosH * hL);   // rear
    const altTL = getAltitude(px - cosH * hW,  pz + sinH * hW);   // track left
    const altTR = getAltitude(px + cosH * hW,  pz - sinH * hW);   // track right
    const altC  = getAltitude(px, pz);                              // centre
    this.position.y = Math.max(altC, (altF + altR) / 2, (altTL + altTR) / 2) + 0.05 * s;

    // ── Turret rotation ────────────────────────────────────────────────────────
    const turretRate = def.turretSpeed * 0.012 * this.turretSpeedMult;  // stat → rad/s
    if (input.turretLeft)  this.turretYaw += turretRate * dt;
    if (input.turretRight) this.turretYaw -= turretRate * dt;

    // ── Reload timer ──────────────────────────────────────────────────────────
    if (this.reloadTimer < this.reloadTime) this.reloadTimer += dt;

    // ── Orient hull to terrain normal ─────────────────────────────────────────
    this._orient();

    // ── Update Three.js mesh ──────────────────────────────────────────────────
    this.mesh.position.copy(this.position);
    this.turretGroup.rotation.y = this.turretYaw;
  }

  // ── Hull orientation: align to terrain slope ──────────────────────────────────
  _orient() {
    const px = this.position.x;
    const pz = this.position.z;

    // Forward vector from heading
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);

    // World-space terrain normal via finite differences in world X and Z.
    // These are independent of tank heading, so the tilt is always correct.
    const dydx = (getAltitude(px + NORM_EPS, pz) - getAltitude(px - NORM_EPS, pz)) / (2 * NORM_EPS);
    const dydz = (getAltitude(px, pz + NORM_EPS) - getAltitude(px, pz - NORM_EPS)) / (2 * NORM_EPS);
    _norm.set(-dydx, 1, -dydz).normalize();
    _fwdAdj.set(-sinH, 0, -cosH);

    // Remove component along normal, then renormalize
    const dot = _fwdAdj.dot(_norm);
    _fwdAdj.x -= _norm.x * dot;
    _fwdAdj.y -= _norm.y * dot;
    _fwdAdj.z -= _norm.z * dot;
    _fwdAdj.normalize();

    // right = fwd × norm → local +X = world right
    _right.crossVectors(_fwdAdj, _norm);

    // Tank model faces -Z; col2 = local +Z in world = backward = -fwdAdj
    _fwdAdj.negate();  // reuse as backward vec (reset at start of next call)
    _basis.makeBasis(_right, _norm, _fwdAdj);
    _qTarget.setFromRotationMatrix(_basis);

    this.mesh.quaternion.copy(_qTarget);
  }

  // ── Third-person camera update ─────────────────────────────────────────────────
  updateCamera(camera, dt) {
    // Snap on first frame
    if (!this._camInit) {
      this._camHeading = this.heading;
      this._camInit    = true;
    }

    // Smoothly steer _camHeading toward tank heading (prevents wild swing on turns)
    const lagHead = 1 - Math.pow(1 - CAM_HEAD_LAG, dt * 60);
    let hdiff = this.heading - this._camHeading;
    // Wrap to [-π, π] for shortest-path rotation
    hdiff = ((hdiff % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    this._camHeading += hdiff * lagHead;

    const sinCam  = Math.sin(this._camHeading);
    const cosCam  = Math.cos(this._camHeading);
    const sinTank = Math.sin(this.heading);
    const cosTank = Math.cos(this.heading);

    // Camera sits behind tank in the smoothed heading direction
    _camTarget.set(
      this.position.x + sinCam * CAM_BEHIND,
      this.position.y + CAM_UP,
      this.position.z + cosCam * CAM_BEHIND,
    );

    // Look slightly ahead of where the tank faces so terrain is visible
    _lookAt.set(
      this.position.x - sinTank * 4,
      this.position.y + 2.0,
      this.position.z - cosTank * 4,
    );

    // Snap _camPos/_camLook on first frame
    if (this._camPos.lengthSq() === 0) {
      this._camPos.copy(_camTarget);
      this._camLook.copy(_lookAt);
    }

    // Exponential lag (frame-rate-independent)
    const lagPos  = 1 - Math.pow(1 - CAM_LAG,      dt * 60);
    const lagLook = 1 - Math.pow(1 - CAM_LOOK_LAG,  dt * 60);
    this._camPos.lerp(_camTarget, lagPos);
    this._camLook.lerp(_lookAt,   lagLook);

    camera.position.copy(this._camPos);
    camera.lookAt(this._camLook);
  }

  // ── LAN networking: state serialisation ──────────────────────────────────────

  /** Returns a compact snapshot for transmission over the network. */
  getState() {
    return {
      x:  this.position.x,
      y:  this.position.y,
      z:  this.position.z,
      h:  this.heading,
      ty: this.turretYaw,
      ge: this.gunElevation,
      hp: this.hp,
      al: this.alive ? 1 : 0,
      ls: this.leftSpeed,
      rs: this.rightSpeed,
      rt: this.reloadTimer,
    };
  }

  /**
   * Applies a received network snapshot to this tank and updates the mesh.
   * Used by the client to position all remote tanks from host state.
   */
  applyState(s) {
    this.position.x   = s.x;
    this.position.y   = s.y;
    this.position.z   = s.z;
    this.heading      = s.h;
    this.turretYaw    = s.ty;
    this.gunElevation = s.ge;
    this.hp           = s.hp;
    this.alive        = s.al === 1;
    this.leftSpeed    = s.ls;
    this.rightSpeed   = s.rs;
    this.reloadTimer  = s.rt;
    // Sync mesh
    this._orient();
    this.mesh.position.copy(this.position);
    this.turretGroup.rotation.y = this.turretYaw;
  }

  // ── Destroyed state — call once when tank.alive becomes false ────────────────
  setDestroyed() {
    // Turret blown off; hull remains as wreckage
    this.turretGroup.visible = false;
    // Slight random lean to look crashed — applied in local space so it stacks
    // on top of the current terrain-normal orientation correctly.
    this.mesh.rotateZ((Math.random() - 0.5) * 0.18);
    this.mesh.rotateX((Math.random() - 0.5) * 0.10);
  }

  // ── Damage ────────────────────────────────────────────────────────────────────
  // penetration : attacker firepower value
  // hitDot      : dot(shellDir_xz_normalised, tankForward_xz)
  //               −1 = dead front, 0 = broadside, +1 = dead rear
  // Armour zones: front (±45°), side, rear (±45°) — thresholds at cos(45°)≈0.707
  // Returns { penetrated: bool, damage: number }
  getHit(penetration, hitDot = 0) {
    if (!this.alive) return { penetrated: false, damage: 0 };
    const def    = this.def;
    const armour = hitDot <= -0.707 ? def.frontArmour
                 : hitDot >=  0.707 ? def.rearArmour
                 :                    def.sideArmour;
    // Deflect if penetration cannot overcome armour (threshold: pen < armour × 0.6)
    if (penetration < armour * 0.6) return { penetrated: false, damage: 0 };
    const damage = Math.max(1, penetration - armour * 0.4) * this.damageMult;
    this.hp = Math.max(0, this.hp - damage);
    if (this.hp <= 0) this.alive = false;
    return { penetrated: true, damage: Math.round(damage) };
  }

  // Bounding sphere radius for hit detection — from authentic vertex extents
  get hitRadius() { return this._hitRadius; }

  // ── Read-outs for HUD ──────────────────────────────────────────────────────────
  get speedKmh() {
    const avg = (Math.abs(this.leftSpeed) + Math.abs(this.rightSpeed)) * 0.5;
    // Convert wu/s to display km/h (cosmetic: 1 wu/s ≈ 5 km/h)
    return Math.round(avg * 5);
  }

  get headingDeg() {
    // 0° = North (−Z), clockwise
    let deg = ((-this.heading) * 180 / Math.PI) % 360;
    if (deg < 0) deg += 360;
    return Math.round(deg);
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.traverse(obj => {
      if (obj.isMesh) {
        obj.geometry.dispose();
      }
    });
  }
}
