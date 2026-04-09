// ctf.js — Capture the Flag game mode for Online (LAN) play
//
// Architecture:
//   Host is authoritative. CTFManager.update() runs only on host.
//   CTF state is embedded in each snapshot and applied on clients via applyState().
//   Events (pickup, capture, etc.) are piggybacked into the existing lanEvents array.

import * as THREE from 'three';
import { getAltitude } from './terrain.js';

export const CTF_WIN_SCORE    = 3;
export const CTF_DROP_SECS    = 30;   // auto-return timer for dropped flags
export const CTF_RESPAWN_SECS = 8;    // seconds before dead player respawns
const CTF_PICKUP_R   = 5;             // world units — flag pickup radius
const CTF_CAPTURE_R  = 5;             // world units — capture/return radius
export const CTF_CARRIER_SPEED = 0.75;// speed multiplier for flag carrier
export const FLAG_COLORS = [0xD4B822, 0x3A8FE8];  // gold, blue
export const FLAG_NAMES  = ['GOLD',   'BLUE'];

// ── FlagVisual ─────────────────────────────────────────────────────────────────
// Three.js meshes for one flag: disc platform, pole, waving panel.
class FlagVisual {
  constructor(scene, team) {
    this._scene = scene;

    // Base disc
    const discGeo = new THREE.CylinderGeometry(2, 2, 0.3, 12);
    const discMat = new THREE.MeshBasicMaterial({ color: FLAG_COLORS[team] });
    this._disc = new THREE.Mesh(discGeo, discMat);
    this._disc.visible = false;
    scene.add(this._disc);

    // Pole
    const poleGeo = new THREE.CylinderGeometry(0.12, 0.12, 8, 6);
    const poleMat = new THREE.MeshBasicMaterial({ color: 0xAAAAAA });
    this._pole = new THREE.Mesh(poleGeo, poleMat);
    this._pole.visible = false;
    scene.add(this._pole);

    // Waving flag panel (4 segments along X for wave effect)
    this._panelGeo = new THREE.BoxGeometry(2.4, 1.2, 0.1, 4, 1, 1);
    this._panelMat = new THREE.MeshBasicMaterial({ color: FLAG_COLORS[team], side: THREE.DoubleSide });
    this._panel    = new THREE.Mesh(this._panelGeo, this._panelMat);
    this._panel.visible = false;
    scene.add(this._panel);

    // Cache original panel vertex Z for waving
    const pos = this._panelGeo.attributes.position;
    this._origZ = new Float32Array(pos.count);
    this._origX = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      this._origZ[i] = pos.getZ(i);
      this._origX[i] = pos.getX(i);
    }
    this._waveT = Math.random() * Math.PI * 2;
    this._base  = new THREE.Vector3();
  }

  setBase(x, y, z) {
    this._base.set(x, y, z);
    this._disc.position.set(x, y + 0.15, z);
    this._disc.visible = true;
  }

  placeAtBase() {
    const { x, y, z } = this._base;
    this._pole.position.set(x, y + 4, z);
    this._pole.visible = true;
    this._panel.position.set(x + 1.2, y + 7.4, z);
    this._panel.visible = true;
  }

  placeAboveTank(tank) {
    this._pole.visible = false;
    const h = (tank.def?.modelScale ?? 1) * 2.5 + 2.5;
    this._panel.position.set(tank.position.x + 1.2, tank.position.y + h, tank.position.z);
    this._panel.visible = true;
  }

  placeDropped(x, y, z) {
    this._pole.visible = false;
    this._panel.position.set(x + 1.2, y + 0.6, z);
    this._panel.visible = true;
  }

  hide() {
    this._pole.visible  = false;
    this._panel.visible = false;
  }

  update(dt) {
    this._waveT += dt * 2.8;
    const pos = this._panelGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const ox = this._origX[i];
      // Only right-side vertices (positive X relative to attach point) wave
      const wave = Math.sin(this._waveT + ox * 1.2) * 0.12 * Math.max(0, ox + 1.2);
      pos.setZ(i, this._origZ[i] + wave);
    }
    pos.needsUpdate = true;
  }

  dispose() {
    [this._disc, this._pole, this._panel].forEach(m => {
      this._scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
  }
}

// ── CTFManager ─────────────────────────────────────────────────────────────────
export class CTFManager {
  constructor(scene) {
    this._scene   = scene;
    this._visuals = [new FlagVisual(scene, 0), new FlagVisual(scene, 1)];
    this._bases   = [new THREE.Vector3(), new THREE.Vector3()];
    this._active  = false;
    this._reset();
  }

  _reset() {
    // Per-flag state
    this._flags = [
      { status: 'base', carrierId: null, carrierName: '', carrierTank: null,
        dropPos: new THREE.Vector3(), dropTimer: 0 },
      { status: 'base', carrierId: null, carrierName: '', carrierTank: null,
        dropPos: new THREE.Vector3(), dropTimer: 0 },
    ];
    this._scores   = [0, 0];
    this._winner   = null;
    this._events   = [];
    this._respawns = new Map();  // playerId → { timer, team, tankKey }
  }

  // ── Initialise for a new game ────────────────────────────────────────────────
  // baseXZ: [{x,z}, {x,z}] — world positions for team-0 and team-1 flag bases
  init(baseXZ) {
    this._reset();
    this._active = true;
    for (let t = 0; t < 2; t++) {
      const { x, z } = baseXZ[t];
      const y = getAltitude(x, z);
      this._bases[t].set(x, y, z);
      this._visuals[t].setBase(x, y, z);
      this._visuals[t].placeAtBase();
    }
  }

  // ── Host-only per-frame update ───────────────────────────────────────────────
  // allPlayers: [{id, name, team, tank}] — every player in the game
  update(dt, allPlayers) {
    if (!this._active || this._winner !== null) return;

    for (let f = 0; f < 2; f++) {
      const fs         = this._flags[f];
      const enemyTeam  = 1 - f;   // flag f belongs to team f; enemies pick it up

      if (fs.status === 'base') {
        // Pickup by enemy team
        for (const p of allPlayers) {
          if (!p.tank?.alive) continue;
          if (p.team !== enemyTeam) continue;
          if (p.tank.ctfCarrying) continue;
          const dx = p.tank.position.x - this._bases[f].x;
          const dz = p.tank.position.z - this._bases[f].z;
          if (dx*dx + dz*dz < CTF_PICKUP_R * CTF_PICKUP_R) {
            this._pickup(f, p);
            break;
          }
        }

      } else if (fs.status === 'carried') {
        if (!fs.carrierTank?.alive) {
          // Carrier died — drop flag
          this._drop(f, fs.carrierTank?.position ?? this._bases[f]);
          continue;
        }

        // Capture: carrier reaches their OWN base (team enemyTeam's base)
        const ownBase = this._bases[enemyTeam];
        const dx = fs.carrierTank.position.x - ownBase.x;
        const dz = fs.carrierTank.position.z - ownBase.z;
        if (dx*dx + dz*dz < CTF_CAPTURE_R * CTF_CAPTURE_R) {
          // Only valid if own flag is safely at base
          if (this._flags[enemyTeam].status === 'base') {
            this._capture(f, fs);
          }
        }

      } else if (fs.status === 'dropped') {
        fs.dropTimer -= dt;

        for (const p of allPlayers) {
          if (!p.tank?.alive) continue;
          if (p.tank.ctfCarrying) continue;
          const dx = p.tank.position.x - fs.dropPos.x;
          const dz = p.tank.position.z - fs.dropPos.z;
          if (dx*dx + dz*dz < CTF_PICKUP_R * CTF_PICKUP_R) {
            if (p.team === enemyTeam) {
              this._pickup(f, p);   // enemy picks up dropped flag
            } else {
              this._return(f);      // own team returns it
            }
            break;
          }
        }

        if (this._flags[f].status === 'dropped' && fs.dropTimer <= 0) {
          this._return(f);
        }
      }
    }

    // Advance respawn timers
    for (const [id, rs] of this._respawns) {
      rs.timer -= dt;
      if (rs.timer <= 0) {
        this._events.push({ type: 'respawn', id, team: rs.team, tankKey: rs.tankKey });
        this._respawns.delete(id);
      }
    }
  }

  // ── Client-only visual update (no game logic) ────────────────────────────────
  // allPlayers: [{id, tank}]
  updateVisuals(dt, allPlayers) {
    for (let f = 0; f < 2; f++) {
      const fs = this._flags[f];
      const fv = this._visuals[f];
      fv.update(dt);
      if (fs.status === 'base') {
        fv.placeAtBase();
      } else if (fs.status === 'carried') {
        const cp = allPlayers.find(p => p.id === fs.carrierId);
        if (cp?.tank?.alive) fv.placeAboveTank(cp.tank); else fv.hide();
      } else {
        fv.placeDropped(fs.dropPos.x, fs.dropPos.y, fs.dropPos.z);
      }
    }
  }

  // ── State serialisation ──────────────────────────────────────────────────────
  getState() {
    return {
      scores:  [...this._scores],
      winner:  this._winner,
      flags:   this._flags.map(fs => ({
        status:      fs.status,
        carrierId:   fs.carrierId,
        carrierName: fs.carrierName,
        dx: fs.dropPos.x, dy: fs.dropPos.y, dz: fs.dropPos.z,
        dropTimer:   fs.dropTimer,
      })),
      respawns: [...this._respawns.entries()].map(([id, rs]) =>
        ({ id, timer: rs.timer, team: rs.team, tankKey: rs.tankKey })),
    };
  }

  applyState(state, allPlayers) {
    if (!state) return;
    this._scores = state.scores ?? this._scores;
    this._winner = state.winner ?? null;

    if (state.flags) {
      for (let f = 0; f < 2; f++) {
        const fd = state.flags[f];
        if (!fd) continue;
        const fs        = this._flags[f];
        fs.status       = fd.status;
        fs.carrierId    = fd.carrierId;
        fs.carrierName  = fd.carrierName ?? '';
        fs.dropPos.set(fd.dx ?? 0, fd.dy ?? 0, fd.dz ?? 0);
        fs.dropTimer    = fd.dropTimer ?? 0;
        // Resolve carrier tank reference
        if (fs.status === 'carried') {
          const cp = allPlayers.find(p => p.id === fd.carrierId);
          fs.carrierTank       = cp?.tank ?? null;
          if (fs.carrierTank) fs.carrierTank.ctfCarrying = true;
        } else {
          if (fs.carrierTank) fs.carrierTank.ctfCarrying = false;
          fs.carrierTank = null;
        }
      }
    }

    if (state.respawns) {
      this._respawns.clear();
      for (const rs of state.respawns) {
        this._respawns.set(rs.id, { timer: rs.timer, team: rs.team, tankKey: rs.tankKey });
      }
    }
  }

  // ── Respawn API ──────────────────────────────────────────────────────────────
  queueRespawn(playerId, team, tankKey) {
    this._respawns.set(playerId, { timer: CTF_RESPAWN_SECS, team, tankKey });
  }

  getRespawnTimer(playerId) {
    return this._respawns.get(playerId)?.timer ?? null;
  }

  // ── Accessors ────────────────────────────────────────────────────────────────
  getScores()          { return [...this._scores]; }
  getWinner()          { return this._winner; }
  isActive()           { return this._active && this._winner === null; }
  getBasePos(team)     { return this._bases[team]; }
  getFlagStatus(t)     { return this._flags[t].status; }
  getFlagCarrierName(t){ return this._flags[t].carrierName; }
  getFlagCarrierId(t)  { return this._flags[t].carrierId; }
  getFlagDropPos(t)    { return this._flags[t].dropPos; }
  getDropTimer(t)      { return this._flags[t].dropTimer; }
  getEvents()          { return this._events; }
  clearEvents()        { this._events = []; }

  dispose() {
    for (const v of this._visuals) v.dispose();
    this._active = false;
  }

  // ── Internal flag operations (host only) ─────────────────────────────────────
  _pickup(flagTeam, player) {
    const fs      = this._flags[flagTeam];
    fs.status      = 'carried';
    fs.carrierTank = player.tank;
    fs.carrierId   = player.id;
    fs.carrierName = player.name;
    player.tank.ctfCarrying = true;
    this._events.push({ type: 'pickup', flagTeam, playerId: player.id, playerName: player.name });
  }

  _drop(flagTeam, pos) {
    const fs = this._flags[flagTeam];
    if (fs.carrierTank) fs.carrierTank.ctfCarrying = false;
    fs.status      = 'dropped';
    fs.carrierTank = null;
    fs.carrierId   = null;
    fs.dropPos.set(pos.x, pos.y, pos.z);
    fs.dropTimer   = CTF_DROP_SECS;
    this._events.push({ type: 'drop', flagTeam, x: pos.x, y: pos.y, z: pos.z });
  }

  _return(flagTeam) {
    const fs = this._flags[flagTeam];
    if (fs.carrierTank) fs.carrierTank.ctfCarrying = false;
    fs.status      = 'base';
    fs.carrierTank = null;
    fs.carrierId   = null;
    fs.carrierName = '';
    this._visuals[flagTeam].placeAtBase();
    this._events.push({ type: 'return', flagTeam });
  }

  _capture(flagTeam, fs) {
    const scoringTeam = 1 - flagTeam;   // carrier's team = enemy of flag owner
    if (fs.carrierTank) fs.carrierTank.ctfCarrying = false;
    const carrierName = fs.carrierName;
    fs.status      = 'base';
    fs.carrierTank = null;
    fs.carrierId   = null;
    fs.carrierName = '';
    this._visuals[flagTeam].placeAtBase();
    this._scores[scoringTeam]++;
    const scores = [...this._scores];
    this._events.push({ type: 'capture', flagTeam, scoringTeam, scores, carrierName });
    if (this._scores[scoringTeam] >= CTF_WIN_SCORE) {
      this._winner = scoringTeam;
      this._active = false;
      this._events.push({ type: 'gameover', winner: scoringTeam, scores });
    }
  }
}
