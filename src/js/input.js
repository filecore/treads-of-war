// input.js — Keyboard state + dual-track and simple (WASD) control modes
//
// Advanced (original) layout from the Archimedes !Help file:
//   H = left track forward    N = left track reverse
//   K = right track forward   M = right track reverse
//   Q / E = turret left / right
//   Space / F = fire
//
// Simple (WASD) layout:
//   W = forward   S = backward   A = turn left   D = turn right
//   Q / E = turret left / right   Space / F = fire

export class Input {
  constructor() {
    this.keys      = {};
    this._prevKeys = {};
    this.simpleMode = false;   // toggled by settings panel

    window.addEventListener('keydown', e => {
      this.keys[e.code] = true;
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', e => {
      this.keys[e.code] = false;
    });
  }

  // Call once per frame after all input has been consumed
  tick() {
    for (const k in this.keys) this._prevKeys[k] = this.keys[k];
  }

  _justPressed(code) { return !!(this.keys[code] && !this._prevKeys[code]); }

  // ── Track controls ────────────────────────────────────────────────────────────
  get leftFwd() {
    if (this.simpleMode) {
      const W = !!this.keys['KeyW'], S = !!this.keys['KeyS'];
      const A = !!this.keys['KeyA'], D = !!this.keys['KeyD'];
      if (W)       return !A;     // W / W+D: left forward; W+A: left coasts
      if (!W && !S) return D;     // D pivot: left track forward
      return false;               // S or S+A: left coasts
    }
    return !!this.keys['KeyH'];
  }

  get leftBwd() {
    if (this.simpleMode) {
      const W = !!this.keys['KeyW'], S = !!this.keys['KeyS'];
      const A = !!this.keys['KeyA'], D = !!this.keys['KeyD'];
      if (S)        return !A;    // S / S+D: left back; S+A: left coasts
      if (!W && !S) return A;     // A pivot: left track backward
      return false;
    }
    return !!this.keys['KeyN'];
  }

  get rightFwd() {
    if (this.simpleMode) {
      const W = !!this.keys['KeyW'], S = !!this.keys['KeyS'];
      const A = !!this.keys['KeyA'], D = !!this.keys['KeyD'];
      if (W)        return !D;    // W / W+A: right forward; W+D: right coasts
      if (!W && !S) return A;     // A pivot: right track forward
      return false;
    }
    return !!this.keys['KeyK'];
  }

  get rightBwd() {
    if (this.simpleMode) {
      const W = !!this.keys['KeyW'], S = !!this.keys['KeyS'];
      const A = !!this.keys['KeyA'], D = !!this.keys['KeyD'];
      if (S)        return !D;    // S / S+A: right back; S+D: right coasts
      if (!W && !S) return D;     // D pivot: right track backward
      return false;
    }
    return !!this.keys['KeyM'];
  }

  // ── Gunner ────────────────────────────────────────────────────────────────────
  get turretLeft()  { return !!(this.keys['KeyQ']); }
  get turretRight() { return !!(this.keys['KeyE']); }
  get fire()        { return !!(this.keys['Space'] || this.keys['KeyF']); }
  get fireOnce() {
    return this._justPressed('Space') || this._justPressed('KeyF');
  }
  get smokeOnce()      { return this._justPressed('KeyG'); }
  get ammoSwitch()     { return this._justPressed('Tab'); }
  get artilleryOnce()  { return this._justPressed('KeyC'); }

  // ── General ───────────────────────────────────────────────────────────────────
  get pause() {
    if (this.simpleMode) return !!(this.keys['Escape'] || this.keys['KeyP']);
    return !!(this.keys['KeyP']);
  }
  get nextTank()    { return !!(this.keys['Tab']); }
  get sightToggle() { return this._justPressed('KeyV'); }
}
