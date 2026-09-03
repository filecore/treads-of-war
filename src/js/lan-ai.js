// lan-ai.js — Host-side AI controller for bot tanks in Online multiplayer.
//
// Adapted from WingmanController (ai.js): same nearest-enemy targeting,
// steer-then-patrol movement, and turret aim/fire behaviour, but the enemy
// pool is whichever online players/bots are not on this bot's team instead
// of a fixed singleplayer enemy list.
//
// Only ever instantiated and updated by the host — clients render bot tanks
// purely from received snapshots, same as any other peer.

import { ballisticElevation } from './combat.js?v=59';
import { steerToward } from './ai.js?v=59';
import { CONFIG } from './config.js?v=59';

const MAP_SAFE       = CONFIG.MAP_HALF - 20;
const PATROL_RADIUS  = 220;
const WAYPOINT_DIST  = 8;
const AI_TURRET_MULT = 0.65;
const AI_SPREAD      = 0.052;
const STOP_DIST      = 110;

export class LanBotController {
  constructor(tank, team) {
    this.tank    = tank;
    this.team    = team;
    this._fireLag = 1.5 + Math.random() * 2.0;

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
    steerToward(this.tank, this._wpX, this._wpZ, 0.70);
  }

  /**
   * enemyList: [{ tank: Tank, team: number }] for every other tank in the room.
   * combatManager/particles: same instances the host uses for real players.
   * Returns the muzzle tip {x,y,z} if it fired this frame, else null — the
   * caller (main.js host loop) is responsible for broadcasting that event.
   */
  update(dt, enemyList, combatManager, particles) {
    const tank = this.tank;
    if (!tank.alive) return null;

    let target = null, bestDist2 = Infinity;
    for (const e of enemyList) {
      if (e.team === this.team || !e.tank.alive) continue;
      const dx = e.tank.position.x - tank.position.x;
      const dz = e.tank.position.z - tank.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist2) { bestDist2 = d2; target = e.tank; }
    }

    if (!target) {
      this._patrol(dt);
      return null;
    }

    const dx   = target.position.x - tank.position.x;
    const dz   = target.position.z - tank.position.z;
    const dist = Math.sqrt(bestDist2);

    if (dist > STOP_DIST) {
      steerToward(this.tank, target.position.x, target.position.z, 0.65);
    } else {
      this._patrol(dt);
    }

    // Aim turret
    const targetHeading = Math.atan2(-dx, -dz);
    let yawDiff = targetHeading - tank.heading - tank.turretYaw;
    yawDiff = ((yawDiff % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    const step = tank.def.turretSpeed * 0.012 * AI_TURRET_MULT * dt;
    tank.turretYaw += Math.sign(yawDiff) * Math.min(Math.abs(yawDiff), step);
    tank.gunElevation = ballisticElevation(dist,
      (target.position.y + target.hitRadius * 0.5) - (tank.position.y + tank.muzzleHeight));

    // Fire when aimed
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
        return tip;
      }
    }
    return null;
  }
}
