// game.js — Game state management, scoring, and wave tracking

export const STATES = Object.freeze({
  MENU:           'MENU',
  PLAYING:        'PLAYING',
  PAUSED:         'PAUSED',
  WAVE_COMPLETE:  'WAVE_COMPLETE',
  GAME_OVER:      'GAME_OVER',
  VICTORY:        'VICTORY',
  PURCHASE:       'PURCHASE',        // Strategy mode — fleet purchase screen
  BATTLE_COMPLETE:'BATTLE_COMPLETE', // Attrition/Strategy — battle won, proceed
});

export class GameManager {
  constructor() {
    this.state      = STATES.MENU;
    this.score      = 0;
    this.kills      = 0;
    this.wave       = 1;
    this.totalWaves = 3;
  }

  start() {
    this.state = STATES.PLAYING;
    this.score = 0;
    this.kills = 0;
    this.wave  = 1;
  }

  startFresh() {
    // Re-enter PLAYING without resetting score/kills — for multi-battle modes
    this.state = STATES.PLAYING;
  }

  togglePause() {
    if      (this.state === STATES.PLAYING) this.state = STATES.PAUSED;
    else if (this.state === STATES.PAUSED)  this.state = STATES.PLAYING;
  }

  // Call each frame to track a newly destroyed enemy tank
  addKill(tankDef) {
    this.kills++;
    this.score += tankDef.cost ?? 100;
  }

  // Standard end-condition check (Arcade / 3-wave mode)
  checkEndConditions(player, enemies, hasRespawn = false) {
    if (this.state !== STATES.PLAYING) return;
    if (!player.alive) {
      if (!hasRespawn) this.state = STATES.GAME_OVER;
      return;
    }
    if (enemies.every(e => !e.alive)) {
      this.state = this.wave >= this.totalWaves ? STATES.VICTORY : STATES.WAVE_COMPLETE;
    }
  }

  // Multi-tank fleet end-condition check (Attrition / Strategy)
  // playerFleet: all allied tanks (including currently controlled one)
  checkFleetEndConditions(playerFleet, enemies) {
    if (this.state !== STATES.PLAYING) return;
    if (playerFleet.every(t => !t.alive)) {
      this.state = STATES.GAME_OVER;
      return;
    }
    if (enemies.every(e => !e.alive)) {
      this.state = STATES.BATTLE_COMPLETE;
    }
  }

  // Advance to next wave and return to PLAYING state
  advanceWave() {
    this.wave++;
    this.state = STATES.PLAYING;
  }

  get isPlaying() { return this.state === STATES.PLAYING; }
}
