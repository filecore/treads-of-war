// ai.js — Enemy tank AI: IDLE → SEEKING → ENGAGING → RETREATING
// Phase 27: flanking approach + fire-and-move (advance / halt cycle)

import * as THREE from 'three';
import { ballisticElevation } from './combat.js';
import { DIFFICULTY, CONFIG } from './config.js';

// Safe navigation margin — AI targets are kept this far inside the map boundary
// so tanks never get pinned against the wall chasing an unreachable out-of-bounds goal.
const MAP_SAFE = CONFIG.MAP_HALF - 20;

// ── Fixed AI constants (not difficulty-dependent) ─────────────────────────────
const RETREAT_HP       = 0.13;  // retreat when HP drops below 13% (near-dead only)
const TRACKS_WRECKED_HP = 0.12; // tracks destroyed — immobile but turret still operates (original state 3)
const WAYPOINT_DIST = 8;     // world units — close enough to reach waypoint
const PATROL_RADIUS = 220;   // world units — roam wide across the map
const HALT_BRAKE    = 0.80;  // per-frame speed multiplier when halted (frame-rate-independent base)
const ADVANCE_TIME  = 6.0;   // seconds of advancing toward flank position
const HALT_TIME     = 1.0;   // seconds of halting and firing
const AI_TURRET_MULT = 0.65; // AI turret inherently slower than player (on top of difficulty)
const AI_SPREAD      = 0.052; // ±3° random aim error when firing (radians)
// Difficulty-driven constants are read from DIFFICULTY each frame (see config.js)

const _toPlayer = new THREE.Vector3();

// ── AI state machine ──────────────────────────────────────────────────────────
export class AIController {
  constructor(tank, spawnX, spawnZ) {
    this.tank    = tank;
    this.state   = 'IDLE';
    this.spawnX  = spawnX;
    this.spawnZ  = spawnZ;

    // Patrol waypoint
    this._wpX = spawnX;
    this._wpZ = spawnZ;
    this._pickWaypoint();

    // Fire lag timer — initialised from current difficulty
    this._fireLag = DIFFICULTY.fireInterval;
    // Reaction delay: AI doesn't immediately track a new target
    this._reactTimer = 0;

    // Flanking — each enemy approaches from a different sector around the player
    this._flankAngle = Math.random() * Math.PI * 2;   // absolute world angle (0–2π)

    // Fire-and-move cycle
    this._movePhase = 'advance';
    this._moveTimer = ADVANCE_TIME + Math.random() * 1.0;   // stagger first halt
  }

  // ── Main update ───────────────────────────────────────────────────────────────
  // weatherDetectMult:  multiplier on detection range (0.35–1.0 from WeatherManager)
  // weatherFireMult:    multiplier on fire interval (1.0–1.5 from WeatherManager)
  // weatherEngageMult:  multiplier on engage range (0.40–1.0 from WeatherManager)
  update(dt, playerTank, combatManager, particles, obscured = false, weatherDetectMult = 1.0, weatherFireMult = 1.0, weatherEngageMult = 1.0) {
    this._weatherFireMult   = weatherFireMult;
    this._weatherEngageMult = weatherEngageMult;
    const tank   = this.tank;
    const hpFrac = tank.hp / tank.maxHp;

    _toPlayer.set(
      playerTank.position.x - tank.position.x,
      0,
      playerTank.position.z - tank.position.z,
    );
    const dist = _toPlayer.length();

    // ── State transitions ──────────────────────────────────────────────────────
    const D = DIFFICULTY;
    const effEngage = D.engageRange * weatherEngageMult;
    switch (this.state) {
      case 'IDLE':
        if (dist < D.detectRange * weatherDetectMult) {
          this.state = 'SEEKING';
          // Fresh flank angle + difficulty-scaled reaction delay
          this._flankAngle = Math.random() * Math.PI * 2;
          this._movePhase  = 'advance';
          this._moveTimer  = ADVANCE_TIME;
          this._reactTimer = D.reactionDelay * (0.7 + Math.random() * 0.6);
        }
        break;
      case 'SEEKING':
        if (dist > D.disengageRange) this.state = 'IDLE';
        if (dist < effEngage)        this.state = 'ENGAGING';
        if (hpFrac < RETREAT_HP)     this.state = 'RETREATING';
        break;
      case 'ENGAGING':
        if (dist > effEngage * 1.4) this.state = 'SEEKING';
        if (hpFrac < RETREAT_HP)    this.state = 'RETREATING';
        break;
      case 'RETREATING':
        if (dist > D.disengageRange)    this.state = 'IDLE';
        if (hpFrac > RETREAT_HP + 0.1)  this.state = 'SEEKING';
        break;
    }

    // ── Tracks wrecked — immobile but turret still operates (original state 3) ─
    if (hpFrac < TRACKS_WRECKED_HP) {
      tank.leftSpeed  = 0;
      tank.rightSpeed = 0;
      this._aimAndFire(dt, playerTank, combatManager, particles, obscured);
      return;
    }

    // ── Behaviour per state ────────────────────────────────────────────────────
    switch (this.state) {
      case 'IDLE':
        this._patrol(dt);
        break;
      case 'SEEKING':
        // Charge toward player with a slight flank offset for unpredictability
        {
          const fax = Math.max(-MAP_SAFE, Math.min(MAP_SAFE, playerTank.position.x + Math.sin(this._flankAngle) * effEngage * 0.55));
          const faz = Math.max(-MAP_SAFE, Math.min(MAP_SAFE, playerTank.position.z + Math.cos(this._flankAngle) * effEngage * 0.55));
          this._steerToward(dt, fax, faz, 1.0);
        }
        break;
      case 'ENGAGING':
        this._engageFlank(dt, playerTank, combatManager, particles, obscured);
        break;
      case 'RETREATING':
        this._steerToward(dt,
          tank.position.x - _toPlayer.x,
          tank.position.z - _toPlayer.z,
          0.45,
        );
        this._aimAndFire(dt, playerTank, combatManager, particles, obscured);
        break;
    }
  }

  // ── Force immediate retarget to player (called when player hits nearby) ────────
  alertToPlayer() {
    if (this.state === 'IDLE' || this.state === 'SEEKING') {
      this.state       = 'ENGAGING';
      this._movePhase  = 'advance';
      this._moveTimer  = ADVANCE_TIME;
      this._reactTimer = 0;
      this._flankAngle = Math.random() * Math.PI * 2;
    }
  }

  // ── Flanking engage: fire-and-move cycle ──────────────────────────────────────
  _engageFlank(dt, playerTank, combatManager, particles, obscured = false) {
    const D   = DIFFICULTY;
    const tank = this.tank;
    const engR = D.engageRange * (this._weatherEngageMult ?? 1.0);

    // Flank target — orbit around the player, but never further than current distance.
    // Capping at distToPlayer prevents the tank from backing away when the player closes in.
    const _dpx = tank.position.x - playerTank.position.x;
    const _dpz = tank.position.z - playerTank.position.z;
    const _distToPlayer = Math.sqrt(_dpx * _dpx + _dpz * _dpz);
    const orbitR = Math.min(engR * 0.75, _distToPlayer);
    const fax = Math.max(-MAP_SAFE, Math.min(MAP_SAFE, playerTank.position.x + Math.sin(this._flankAngle) * orbitR));
    const faz = Math.max(-MAP_SAFE, Math.min(MAP_SAFE, playerTank.position.z + Math.cos(this._flankAngle) * orbitR));
    const dFx = fax - tank.position.x;
    const dFz = faz - tank.position.z;
    const distToFlank = Math.sqrt(dFx * dFx + dFz * dFz);

    // Advance / halt cycle
    this._moveTimer -= dt;
    if (this._moveTimer <= 0) {
      if (this._movePhase === 'advance') {
        this._movePhase = 'halt';
        this._moveTimer = HALT_TIME + Math.random() * 0.8;
      } else {
        this._movePhase = 'advance';
        this._moveTimer = ADVANCE_TIME + Math.random() * 1.2;
        // Occasionally rotate the flank angle for unpredictability
        if (Math.random() < 0.40) this._flankAngle += (Math.random() - 0.5) * 1.2;
      }
    }

    if (this._movePhase === 'advance' && distToFlank > 12) {
      // Drive toward flank position aggressively
      this._steerToward(dt, fax, faz, 0.87);
    } else {
      // Halt — bleed off speed quickly so the tank fires from a steady position
      const brake = Math.pow(HALT_BRAKE, dt * 60);
      tank.leftSpeed  *= brake;
      tank.rightSpeed *= brake;
    }

    // Turret always tracks; firing suppressed when player is in smoke
    this._aimAndFire(dt, playerTank, combatManager, particles, obscured);
  }

  // ── Steer hull toward world position (throttle 0–1) ──────────────────────────
  // Sets speeds directly each frame; skipAccel in tank.update() passes them through unchanged.
  _steerToward(dt, tx, tz, throttle) {
    const tank = this.tank;
    const dx = tx - tank.position.x;
    const dz = tz - tank.position.z;
    const targetHeading = Math.atan2(-dx, -dz);

    let hdiff = targetHeading - tank.heading;
    hdiff = ((hdiff % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;

    const maxSpeed = tank.maxSpeed * throttle;

    if (Math.abs(hdiff) < 0.15) {
      // Roughly on-heading — full speed both tracks
      tank.leftSpeed  = maxSpeed;
      tank.rightSpeed = maxSpeed;
    } else if (hdiff > 0) {
      // Turn right: slow left track, fast right
      tank.leftSpeed  = maxSpeed * 0.15;
      tank.rightSpeed = maxSpeed;
    } else {
      // Turn left: fast left, slow right
      tank.leftSpeed  = maxSpeed;
      tank.rightSpeed = maxSpeed * 0.15;
    }
  }

  // ── Patrol between random waypoints near spawn ────────────────────────────────
  _patrol(dt) {
    const tank = this.tank;
    const dx = this._wpX - tank.position.x;
    const dz = this._wpZ - tank.position.z;
    if (Math.sqrt(dx * dx + dz * dz) < WAYPOINT_DIST) this._pickWaypoint();
    this._steerToward(dt, this._wpX, this._wpZ, 0.85);
  }

  _pickWaypoint() {
    const a = Math.random() * Math.PI * 2;
    const r = PATROL_RADIUS * (0.4 + Math.random() * 0.6);
    this._wpX = Math.max(-MAP_SAFE, Math.min(MAP_SAFE, this.spawnX + Math.cos(a) * r));
    this._wpZ = Math.max(-MAP_SAFE, Math.min(MAP_SAFE, this.spawnZ + Math.sin(a) * r));
  }

  // ── Turret aim + fire (target = enemy playerTank) ────────────────────────────
  _aimAndFire(dt, playerTank, combatManager, particles, obscured = false) {
    const tank = this.tank;

    // Reaction delay — AI doesn't immediately start tracking on target acquisition
    if (this._reactTimer > 0) {
      this._reactTimer -= dt;
      this._fireLag    -= dt;  // still ticking down so first shot isn't instant after delay
      return;
    }

    const dx = playerTank.position.x - tank.position.x;
    const dz = playerTank.position.z - tank.position.z;

    const targetWorldHeading = Math.atan2(-dx, -dz);
    const desiredYaw = targetWorldHeading - tank.heading;

    // AI turret is inherently slower than player (AI_TURRET_MULT) on top of difficulty scaling
    const turretRate = tank.def.turretSpeed * 0.012 * DIFFICULTY.turretSpeedMult * AI_TURRET_MULT;
    let yawDiff = desiredYaw - tank.turretYaw;
    yawDiff = ((yawDiff % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;

    const step = turretRate * dt;
    tank.turretYaw += Math.sign(yawDiff) * Math.min(Math.abs(yawDiff), step);

    const horizDist = Math.sqrt(dx * dx + dz * dz);
    tank.gunElevation = ballisticElevation(horizDist, playerTank.position.y - tank.position.y);

    this._fireLag -= dt;
    if (!obscured && Math.abs(yawDiff) < DIFFICULTY.aimTolerance && this._fireLag <= 0) {
      // Apply random aim spread — AI misses occasionally unlike a skilled human player
      const savedYaw  = tank.turretYaw;
      const savedElev = tank.gunElevation;
      tank.turretYaw    += (Math.random() - 0.5) * AI_SPREAD * 2;
      tank.gunElevation += (Math.random() - 0.5) * 0.04;
      const tip = combatManager.fire(tank);
      tank.turretYaw    = savedYaw;
      tank.gunElevation = savedElev;
      if (tip) {
        particles.muzzleFlash(tip.x, tip.y, tip.z);
        this._fireLag = (DIFFICULTY.fireInterval + Math.random() * DIFFICULTY.fireRandExtra) * (this._weatherFireMult ?? 1.0);
      }
    }
  }
}

// ── Friendly wingman AI ────────────────────────────────────────────────────────
// Targets the nearest live enemy; uses simple advance-and-fire behaviour.
// Shares _steerToward logic with AIController but is self-contained.
export class WingmanController {
  constructor(tank) {
    this.tank     = tank;
    this._fireLag = 1.5 + Math.random() * 2.0;

    // Patrol waypoint (roam around initial spawn position)
    this._spawnX = tank.position.x;
    this._spawnZ = tank.position.z;
    this._wpX    = tank.position.x;
    this._wpZ    = tank.position.z;
    this._pickWaypoint();
  }

  _pickWaypoint() {
    const a = Math.random() * Math.PI * 2;
    const r = PATROL_RADIUS * (0.4 + Math.random() * 0.6);
    this._wpX = Math.max(-MAP_SAFE, Math.min(MAP_SAFE, this._spawnX + Math.cos(a) * r));
    this._wpZ = Math.max(-MAP_SAFE, Math.min(MAP_SAFE, this._spawnZ + Math.sin(a) * r));
  }

  _patrol(dt) {
    const tank = this.tank;
    const dx = this._wpX - tank.position.x;
    const dz = this._wpZ - tank.position.z;
    if (Math.sqrt(dx * dx + dz * dz) < WAYPOINT_DIST) this._pickWaypoint();
    this._steerToward(dt, this._wpX, this._wpZ, 0.70);
  }

  update(dt, enemies, combatManager, particles) {
    const tank = this.tank;
    if (!tank.alive) return;

    // Find nearest alive enemy
    let target = null, bestDist2 = Infinity;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.position.x - tank.position.x;
      const dz = e.position.z - tank.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist2) { bestDist2 = d2; target = e; }
    }

    if (!target) {
      this._patrol(dt);
      return;
    }

    const dx   = target.position.x - tank.position.x;
    const dz   = target.position.z - tank.position.z;
    const dist = Math.sqrt(bestDist2);

    const STOP_DIST = 110;
    if (dist > STOP_DIST) {
      this._steerToward(dt, target.position.x, target.position.z, 0.65);
    } else {
      // Within engage range — patrol rather than sit still
      this._patrol(dt);
    }

    // Aim turret
    const targetHeading = Math.atan2(-dx, -dz);
    let yawDiff = targetHeading - tank.heading - tank.turretYaw;
    yawDiff = ((yawDiff % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    const step = tank.def.turretSpeed * 0.012 * AI_TURRET_MULT * dt;
    tank.turretYaw += Math.sign(yawDiff) * Math.min(Math.abs(yawDiff), step);
    tank.gunElevation = ballisticElevation(dist, target.position.y - tank.position.y);

    // Fire when aimed (with same accuracy spread as enemy AI)
    this._fireLag -= dt;
    if (Math.abs(yawDiff) < 0.28 && this._fireLag <= 0) {
      const savedYaw  = tank.turretYaw;
      const savedElev = tank.gunElevation;
      tank.turretYaw    += (Math.random() - 0.5) * AI_SPREAD * 2;
      tank.gunElevation += (Math.random() - 0.5) * 0.04;
      const tip = combatManager.fire(tank, 'AP');
      tank.turretYaw    = savedYaw;
      tank.gunElevation = savedElev;
      if (tip) {
        particles.muzzleFlash(tip.x, tip.y, tip.z);
        this._fireLag = tank.reloadTime + 1.0 + Math.random() * 2.0;
      }
    }
  }

  _steerToward(dt, tx, tz, throttle) {
    const tank = this.tank;
    const dx = tx - tank.position.x, dz = tz - tank.position.z;
    const targetHeading = Math.atan2(-dx, -dz);
    let hdiff = targetHeading - tank.heading;
    hdiff = ((hdiff % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    const maxSpeed = tank.maxSpeed * throttle;
    if (Math.abs(hdiff) < 0.15) {
      tank.leftSpeed  = maxSpeed;
      tank.rightSpeed = maxSpeed;
    } else if (hdiff > 0) {
      tank.leftSpeed  = maxSpeed * 0.15;
      tank.rightSpeed = maxSpeed;
    } else {
      tank.leftSpeed  = maxSpeed;
      tank.rightSpeed = maxSpeed * 0.15;
    }
  }
}
