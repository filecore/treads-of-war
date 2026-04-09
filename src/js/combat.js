// combat.js — Shell ballistics, hit detection

import * as THREE from 'three';
import { CONFIG }      from './config.js';
import { getAltitude } from './terrain.js';

const SHELL_SPEED    = 80;    // world units / second
const SHELL_LIFE     = 5.0;   // max seconds before despawn
const GUN_ELEVATION  = 0.06;  // radians — default upward angle (used when no auto-aim)

// ── Ballistic elevation solver ─────────────────────────────────────────────────
// Returns the minimum-angle elevation (radians) needed to hit a target at
// horizontal distance `horiz` and height difference `dy` (positive = target higher).
// Falls back to GUN_ELEVATION when target is out of ballistic range.
export function ballisticElevation(horiz, dy, v = SHELL_SPEED, g = 9.81) {
  if (horiz < 0.5) return GUN_ELEVATION;
  const v2   = v * v;
  const A    = g * horiz * horiz / (2 * v2);
  const disc = horiz * horiz - 4 * A * (dy + A);
  if (disc < 0) return GUN_ELEVATION;
  const u = (horiz - Math.sqrt(disc)) / (2 * A);
  return Math.max(-0.12, Math.min(Math.PI / 3, Math.atan(u)));
}

// ── Shell tracer meshes ────────────────────────────────────────────────────────
// Elongated box aligned to the velocity vector — clearly visible, colour-coded:
//   player shells  → light blue   (0x88CCFF)
//   enemy shells   → orange-red   (0xFF5500)
// The box is rotated each frame to follow the parabolic arc.
const TRACER_LEN  = 10;   // world units — how long the streak appears
const _tracerGeo  = new THREE.BoxGeometry(0.15, 0.15, TRACER_LEN);  // shared; rotation varies per mesh
const _playerMat  = new THREE.MeshBasicMaterial({ color: 0x88CCFF });   // AP — light blue
const _enemyMat   = new THREE.MeshBasicMaterial({ color: 0xFF5500 });   // enemy — orange-red
const _heMat      = new THREE.MeshBasicMaterial({ color: 0xCCFF00 });   // HE — yellow-green
const _fwdVec     = new THREE.Vector3(0, 0, 1);   // reused for quaternion alignment
const _velVec     = new THREE.Vector3();           // reused each frame

// ── Individual shell projectile ────────────────────────────────────────────────
class Shell {
  constructor(scene, x, y, z, vx, vy, vz, firedBy, penetration, ammoType = 'AP') {
    this.px = x;  this.py = y;  this.pz = z;
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.life        = SHELL_LIFE;
    this.alive       = true;
    this.scene       = scene;
    this.firedBy     = firedBy;      // Tank reference — excluded from hit check
    this.penetration = penetration;  // damage value
    this.ammoType    = ammoType;     // 'AP' or 'HE'

    const isEnemy = firedBy.def.faction === 'german';
    const mat = isEnemy ? _enemyMat : (ammoType === 'HE' ? _heMat : _playerMat);
    this.mesh = new THREE.Mesh(_tracerGeo, mat);
    _velVec.set(vx, vy, vz).normalize();
    this.mesh.quaternion.setFromUnitVectors(_fwdVec, _velVec);
    this.mesh.position.set(x, y, z);
    scene.add(this.mesh);
  }

  // Returns impact {x,y,z} on the frame it hits, null while in flight
  update(dt) {
    if (!this.alive) return null;

    this.vy   -= CONFIG.GRAVITY * dt;
    this.px   += this.vx * dt;
    this.py   += this.vy * dt;
    this.pz   += this.vz * dt;
    this.life -= dt;

    const ground = getAltitude(this.px, this.pz);

    if (this.py <= ground || this.life <= 0) {
      this.alive = false;
      const iy = Math.max(this.py, ground);
      this.mesh.position.set(this.px, iy, this.pz);
      return { x: this.px, y: iy, z: this.pz };
    }

    this.mesh.position.set(this.px, this.py, this.pz);
    // Track the gravity-bent arc — rotate tracer to face current velocity
    _velVec.set(this.vx, this.vy, this.vz).normalize();
    this.mesh.quaternion.setFromUnitVectors(_fwdVec, _velVec);
    return null;
  }

  dispose() {
    this.scene.remove(this.mesh);
    // Shared geo/mat — not disposed here
  }
}

// ── Combat manager ─────────────────────────────────────────────────────────────
export class CombatManager {
  constructor(scene) {
    this.scene        = scene;
    this.shells       = [];
    this.friendlyFire = true;   // enabled by default; toggled via settings
  }

  // Attempt to fire from tank. Returns gun tip {x,y,z} for muzzle flash, or null
  // if still reloading. ammoType: 'AP' (default) or 'HE'.
  fire(tank, ammoType = 'AP') {
    if (tank.ctfCarrying) return null;   // flag carrier cannot fire
    if (tank.reloadTimer < tank.reloadTime) return null;
    tank.reloadTimer = 0;

    const heading = tank.heading + tank.turretYaw;
    const sinH    = Math.sin(heading);
    const cosH    = Math.cos(heading);
    const el      = tank.gunElevation ?? GUN_ELEVATION;
    const cosEl   = Math.cos(el);
    const sinEl   = Math.sin(el);

    // Gun tip in world space — uses authentic per-model muzzle offsets
    const tipDist = tank.muzzleDist;
    const tx = tank.position.x - sinH * tipDist;
    const ty = tank.position.y + tank.muzzleHeight;
    const tz = tank.position.z - cosH * tipDist;

    // Initial velocity: horizontal component from heading, vertical from elevation
    const vx = -sinH * cosEl * SHELL_SPEED;
    const vy =  sinEl        * SHELL_SPEED;
    const vz = -cosH * cosEl * SHELL_SPEED;

    this.shells.push(new Shell(this.scene, tx, ty, tz, vx, vy, vz, tank, tank.def.firepower, ammoType));
    return { x: tx, y: ty, z: tz };
  }

  // Returns array of impact positions {x,y,z} from hits this frame.
  // tanks: array of all Tank objects to check for shell-vs-tank collision.
  // shooterTank: the tank that fired (excluded from self-hit).
  update(dt, tanks = []) {
    const impacts = [];
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const shell = this.shells[i];
      let impact = null;

      // ── Shell-vs-tank hit detection ──────────────────────────────────────────
      let hitTank = null;
      for (const t of tanks) {
        if (!t.alive) continue;
        if (t === shell.firedBy) continue;                               // no self-hit
        if (!this.friendlyFire && t.def.faction === shell.firedBy.def.faction) continue;
        const dx = t.position.x - shell.px;
        const dy = t.position.y - shell.py + t.hitRadius * 0.5;  // rough centre
        const dz = t.position.z - shell.pz;
        if (dx*dx + dy*dy + dz*dz < t.hitRadius * t.hitRadius) {
          hitTank = t;
          break;
        }
      }

      if (hitTank) {
        // Compute shell approach angle relative to target hull for armour zone selection.
        // hitDot = dot(shellDir_xz, tankForward_xz): -1=dead front, +1=dead rear.
        const sLen   = Math.sqrt(shell.vx * shell.vx + shell.vz * shell.vz) || 1;
        const tfx    = -Math.sin(hitTank.heading);
        const tfz    = -Math.cos(hitTank.heading);
        const hitDot = (shell.vx / sLen) * tfx + (shell.vz / sLen) * tfz;

        let hitResult;
        const prevHp = hitTank.hp;
        if (shell.ammoType === 'HE') {
          // HE always detonates on contact — no armour check, reduced direct damage
          const dmg = Math.max(1, shell.penetration * 0.5) * hitTank.damageMult;
          hitTank.hp = Math.max(0, hitTank.hp - dmg);
          if (hitTank.hp <= 0) hitTank.alive = false;
          hitResult = { penetrated: true, damage: Math.round(dmg), ricochet: false, preHitHp: prevHp };
        } else {
          // Ricochet check — AP only
          // Use 3D shell velocity to compute angle of incidence against the struck face.
          // Sloped armour tanks subtract slopeBonus° from the effective surface angle,
          // increasing the chance a glancing long-range shot skips off.
          const speed3D = Math.sqrt(shell.vx*shell.vx + shell.vy*shell.vy + shell.vz*shell.vz) || 1;
          let cosIncidence;
          if (Math.abs(hitDot) > 0.707) {
            // Front or rear face: outward normal aligns with tank long axis
            cosIncidence = Math.abs(hitDot) * sLen / speed3D;
          } else {
            // Side face: outward normal is perpendicular to tank long axis
            cosIncidence = Math.sqrt(Math.max(0, 1 - hitDot * hitDot)) * sLen / speed3D;
          }
          const surfaceAngleDeg = 90 - Math.acos(Math.min(1, cosIncidence)) * (180 / Math.PI);
          const effectiveSurfaceAngle = surfaceAngleDeg - (hitTank.def.slopeBonus || 0);
          if (effectiveSurfaceAngle < 20) {
            hitResult = { penetrated: false, damage: 0, ricochet: true, preHitHp: prevHp };
          } else {
            hitResult = hitTank.getHit(shell.penetration, hitDot);
            hitResult.ricochet = false;
            hitResult.preHitHp = prevHp;
          }
        }
        impact = { x: shell.px, y: shell.py, z: shell.pz,
                   penetrated: hitResult.penetrated, damage: hitResult.damage,
                   ricochet: hitResult.ricochet, preHitHp: hitResult.preHitHp ?? 0,
                   hitDot, shellType: shell.ammoType };
        shell.alive = false;
      } else {
        const groundImp = shell.update(dt);
        if (groundImp) impact = { ...groundImp, shellType: shell.ammoType };
      }

      if (!shell.alive) {
        if (impact) impacts.push({ ...impact, tank: hitTank, firedBy: shell.firedBy });
        shell.dispose();
        this.shells.splice(i, 1);
      }
    }
    return impacts;
  }

  dispose() {
    this.shells.forEach(s => s.dispose());
    this.shells.length = 0;
  }
}
