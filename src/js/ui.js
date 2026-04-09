// ui.js — Pure HTML generators for overlay and menu screens.
// All exported functions are stateless: they take a state snapshot (st)
// and return an HTML string.  No DOM manipulation here.

import { CONFIG, DIFFICULTY } from './config.js';
import { TANK_COSTS, FACTION_ROSTERS } from './modes.js';

// ── Faction display label ─────────────────────────────────────────────────────
export function factionLabel(f, plural = false) {
  if (f === 'american')  return plural ? 'Allies'  : 'Allied';
  if (f === 'russian')   return plural ? 'Soviets' : 'Soviet';
  if (f === 'mercenary') return 'Mercs';
  return 'Axis';
}

// ── Shared 8-cell stat bar ────────────────────────────────────────────────────
function statBar(val, max) {
  const n = Math.min(8, Math.max(0, Math.round(val / max * 8)));
  return '\u25A0'.repeat(n) + '\u25A1'.repeat(8 - n);
}

// ── LAN team <select> ─────────────────────────────────────────────────────────
function lanTeamSelHtml(selectId, val, teamNames) {
  return `<select id="${selectId}" class="lan-team-sel">` +
    teamNames.map((n, i) => `<option value="${i}"${i === val ? ' selected' : ''}>${n} Team</option>`).join('') +
    `</select>`;
}

// ── Faction + vehicle columns (shared by main menu and online lobby) ──────────
function menuTankColsHtml(st) {
  const allTanks = [
    ...FACTION_ROSTERS.american,
    ...FACTION_ROSTERS.russian,
    ...FACTION_ROSTERS.german,
    ...FACTION_ROSTERS.mercenary,
  ];
  const maxSelIdx = st.mercsEnabled ? allTanks.length - 1 : 11;
  const key = allTanks[st.selIdx];
  const def = CONFIG.TANK_DEFS[key];
  const arrowL = st.selIdx > 0         ? '\u25C4' : '\u00A0';
  const arrowR = st.selIdx < maxSelIdx ? '\u25BA' : '\u00A0';

  let html = '';

  // Left column: faction selector
  html += '<div class="menu-col">';
  html += '<div class="menu-section-label">FACTION</div>';
  html += '<div class="faction-select">';
  for (const [fkey, fname] of [['american','Allies'],['russian','Soviets'],['german','Axis'],['mercenary','Mercs']].filter(([k]) => k !== 'mercenary' || st.mercsEnabled)) {
    const sel = fkey === st.faction;
    html += `<div class="faction-opt${sel ? ' faction-selected' : ''}" data-faction="${fkey}">`;
    html += `<div class="faction-name">${fname}</div>`;
    html += '</div>';
  }
  html += '</div>';
  html += '</div>';

  // Middle column: vehicle selector
  html += '<div class="menu-col">';
  html += '<div class="menu-section-label">VEHICLE</div>';
  html += '<div class="ts-nav">';
  const isObliterator = (key === 'obliterator');
  const cs = isObliterator ? st.getMercStats() : null;
  const displayName = (isObliterator && cs?.customName) ? cs.customName : def.name;
  html += `<button class="ts-arrow" data-dir="left" ${st.selIdx <= 0 ? 'disabled' : ''}>${arrowL}</button>`;
  html += `<span class="ts-name">${displayName}</span>`;
  html += `<button class="ts-arrow" data-dir="right" ${st.selIdx >= maxSelIdx ? 'disabled' : ''}>${arrowR}</button>`;
  html += '</div>';
  const armourVal = cs ? cs.frontArmour : def.frontArmour;
  const fpVal     = cs ? cs.firepower   : def.firepower;
  const spdVal    = cs ? cs.maxSpeed    : def.maxSpeed;
  const rtVal     = cs ? cs.reloadTime  : def.reloadTime;
  const rdDisp    = (rtVal * DIFFICULTY.reloadMult).toFixed(1);
  const rdBar     = statBar(5 - parseFloat(rdDisp), 5);
  function adjBtns(stat, minusD, plusD) {
    if (!isObliterator) return '';
    return `<span class="merc-adj-pair">` +
           `<button class="merc-adj" data-stat="${stat}" data-delta="${minusD}">−</button>` +
           `<button class="merc-adj" data-stat="${stat}" data-delta="${plusD}">+</button>` +
           `</span>`;
  }
  if (isObliterator) html += '<div class="ts-customise-label">CUSTOMISE LOADOUT</div>';
  html += '<div class="ts-stats">';
  html += `<div class="ts-row"><span class="ts-label">Armour</span><span class="ts-bar">${statBar(armourVal, 100)}</span><span class="ts-val">${armourVal}</span>${adjBtns('frontArmour', -5, 5)}</div>`;
  html += `<div class="ts-row"><span class="ts-label">Firepower</span><span class="ts-bar">${statBar(fpVal, 100)}</span><span class="ts-val">${fpVal}</span>${adjBtns('firepower', -5, 5)}</div>`;
  html += `<div class="ts-row"><span class="ts-label">Speed</span><span class="ts-bar">${statBar(spdVal, 56)}</span><span class="ts-val">${spdVal} km/h</span>${adjBtns('maxSpeed', -5, 5)}</div>`;
  html += `<div class="ts-row"><span class="ts-label">Reload</span><span class="ts-bar">${rdBar}</span><span class="ts-val">${rdDisp}s</span>${adjBtns('reloadTime', 0.5, -0.5)}</div>`;
  html += '</div>';
  if (isObliterator && st.mercEditorEnabled) {
    html += '<button class="merc-edit-btn" id="merc-edit-btn">EDIT</button>';
  }
  html += `<div class="ts-counter">${st.selIdx + 1} / ${allTanks.length}</div>`;
  html += '</div>';

  return html;
}

// ── Obliterator IV editor overlay ─────────────────────────────────────────────
export function mercEditorHtml(st) {
  const cs = st.getMercStats();

  function statRow(label, stat, step, min, max, unit = '') {
    const v = cs[stat];
    const disp = Number.isInteger(v) ? v : v.toFixed(step < 0.1 ? 2 : 1);
    return `<div class="me-row">` +
      `<span class="me-label">${label}</span>` +
      `<button class="me-adj" data-stat="${stat}" data-delta="${-step}" data-min="${min}" data-max="${max}">−</button>` +
      `<span class="me-val" id="mev-${stat}">${disp}${unit}</span>` +
      `<button class="me-adj" data-stat="${stat}" data-delta="${step}" data-min="${min}" data-max="${max}">+</button>` +
      `</div>`;
  }
  function visRow(label, prop, step, min, max, unit = '') {
    const v = cs[prop];
    const disp = v.toFixed(2);
    return `<div class="me-row">` +
      `<span class="me-label">${label}</span>` +
      `<button class="me-vis" data-prop="${prop}" data-delta="${-step}" data-min="${min}" data-max="${max}">−</button>` +
      `<span class="me-val" id="mev-${prop}">${disp}${unit}</span>` +
      `<button class="me-vis" data-prop="${prop}" data-delta="${step}" data-min="${min}" data-max="${max}">+</button>` +
      `</div>`;
  }

  return `<div class="me-panel">
    <div class="me-title">OBLITERATOR IV EDITOR
      <button class="me-close" id="me-close-btn">✕</button>
    </div>
    <div class="me-body">
      <div class="me-section me-section-name">
        <div class="me-section-label">DESIGNATION</div>
        <input class="me-name-input" id="me-name-input" type="text" maxlength="24"
          placeholder="Obliterator IV" value="${cs.customName || ''}">
      </div>
      <div class="me-cols">
        <div class="me-col">
          <div class="me-section-label">COMBAT</div>
          ${statRow('Front armour', 'frontArmour', 5, 5, 200)}
          ${statRow('Side armour',  'sideArmour',  5, 5, 200)}
          ${statRow('Rear armour',  'rearArmour',  5, 5, 200)}
          ${statRow('Firepower',    'firepower',   5, 5, 200)}
          ${statRow('Reload (s)',   'reloadTime',  0.5, 0.5, 10)}
          ${statRow('Trt speed',    'turretSpeed', 5, 5, 200)}
          ${statRow('Accuracy',     'accuracy',    5, 5, 200)}
          <div class="me-section-label" style="margin-top:8px">MOBILITY</div>
          ${statRow('Top speed',  'maxSpeed', 5, 5, 150, ' km/h')}
          ${statRow('XC speed',   'xcSpeed',  5, 5, 150, ' km/h')}
          ${statRow('Accel',      'accel',    5, 5, 200)}
          ${statRow('Turn rate',  'turnRate', 5, 5, 200)}
        </div>
        <div class="me-col">
          <div class="me-section-label">BODY</div>
          ${visRow('Width/Length', 'bodyScaleXZ', 0.05, 0.5, 2.5)}
          ${visRow('Height',       'bodyScaleY',  0.05, 0.5, 2.5)}
          ${visRow('Raise',        'bodyRaise',   0.05, -0.5, 1.0)}
          <div class="me-section-label" style="margin-top:8px">TURRET</div>
          ${visRow('Width/Length', 'turretScaleXZ', 0.05, 0.5, 3.0)}
          ${visRow('Height',       'turretScaleY',  0.05, 0.5, 3.0)}
          ${visRow('Raise',        'turretRaise',   0.05, -0.5, 1.5)}
          <div class="me-section-label" style="margin-top:8px">GUN BARREL</div>
          ${visRow('Length', 'gunLengthMult', 0.1, 0.2, 4.0)}
          ${visRow('Radius', 'gunRadiusMult', 0.1, 0.2, 4.0)}
        </div>
      </div>
      <div class="me-footer">
        <button class="me-btn me-btn-reset" id="me-reset-btn">Reset to defaults</button>
        <button class="me-btn me-btn-done"  id="me-done-btn">Done</button>
      </div>
    </div>
  </div>`;
}

// ── Main menu (combined faction/vehicle/mode) ─────────────────────────────────
export function menuScreenHtml(st) {
  let html = '<div class="menu-combined">';
  html += menuTankColsHtml(st);

  // Right column: mode selector
  html += '<div class="menu-col">';
  html += '<div class="menu-section-label">BATTLE MODE</div>';
  html += '<div class="mode-select">';
  const modeNames = ['Arcade', 'Attrition', 'Strategy', ...(st.lanEnabled ? ['Online'] : [])];
  const modeDescs = [
    'Endless waves \u00B7 Solo \u00B7 Tank upgrades by kills \u00B7 3 lives',
    'Fixed squad of 5 \u00B7 Permanent losses \u00B7 Escalating enemy',
    'Budget purchase \u00B7 Objective capture \u00B7 AI buys too',
    ...(st.lanEnabled ? ['Up to 16 players \u00B7 Coop or Vs \u00B7 Pick any tank'] : []),
  ];
  const modeIdx = Math.min(st.modeSelIdx, modeNames.length - 1);
  for (let i = 0; i < modeNames.length; i++) {
    const sel = i === modeIdx;
    html += `<div class="mode-opt${sel ? ' mode-selected' : ''}" data-mode-idx="${i}">`;
    html += `<div class="mode-name">${sel ? '<span class="mode-sel-arrow">\u25B6</span> ' : ''}${modeNames[i]}</div>`;
    html += `<div class="mode-desc">${modeDescs[i]}</div>`;
    html += '</div>';
  }
  html += '</div>';
  html += '</div>';

  html += '</div>';
  html += `<button class="menu-start-btn" id="menu-start-btn">START</button>`;
  return html;
}

// ── Online lobby pre-room: tank selector + connect controls ───────────────────
function onlinePreRoomHtml(st) {
  let html = '<div class="menu-combined">';
  html += menuTankColsHtml(st);

  html += '<div class="menu-col lan-online-col">';
  html += `<div class="lan-name-row">` +
    `<input id="lan-name-input" class="lan-input lan-name-input" type="text" maxlength="16" placeholder="Player" value="${st.lanPlayerName}" />` +
    `${lanTeamSelHtml('lan-team-sel', st.lanMyTeam, st.lanTeamNames)}` +
    `</div>`;
  html += `<div class="lan-host-row" style="margin-top:12px">` +
    `<button id="lan-host-btn" class="lan-btn">Host Game</button>` +
    `<select id="lan-max-players" class="lan-team-sel">` +
    `${[2,3,4,5,6,8,10,12,16].map(n => `<option value="${n}"${n === st.lanMaxPlayers ? ' selected' : ''}>${n} players</option>`).join('')}` +
    `</select>` +
    `<select id="lan-game-type" class="lan-team-sel" style="margin-left:6px">` +
    `<option value="deathmatch"${!st.ctfMode ? ' selected' : ''}>Deathmatch</option>` +
    `<option value="ctf"${st.ctfMode ? ' selected' : ''}>Capture the Flag</option>` +
    `</select>` +
    `</div>`;
  html += `<div class="lan-join-row" style="margin-top:8px">` +
    `<button id="lan-scan-btn" class="lan-btn">Join A Game</button>` +
    `<input id="lan-code-input" class="lan-input lan-code-input" type="text" maxlength="4" placeholder="CODE" value="${st.lanRoomCode}" />` +
    `<button id="lan-join-btn" class="lan-btn">Join</button>` +
    `</div>`;
  html += `<div id="lan-scan-results" class="lan-scan-results"></div>`;
  html += `<span id="lan-scan-status" class="lan-scan-status"></span>`;
  html += `<div class="lan-status">${st.lanStatus}</div>`;
  html += `<div style="margin-top:10px">` +
    `<button id="lan-back-btn" class="lan-btn lan-btn-danger">Back to Main Menu</button>` +
    `</div>`;
  html += '</div>';

  html += '</div>';
  return html;
}

// ── Online waiting room ───────────────────────────────────────────────────────
export function lanLobbyHtml(st) {
  const inRoom = !!st.lanRoomCode && st.lanMode;
  const isHost = st.lanNet && st.lanNet.isHost();

  let rosterHtml = '';
  if (inRoom) {
    rosterHtml = '<div class="lan-waiting-room">';
    rosterHtml += `<div class="lan-waiting-title">Room <b>${st.lanRoomCode}</b>  ·  ${st.lanRoster.size} / ${st.lanMaxPlayers} players</div>`;
    rosterHtml += '<div class="lan-waiting-list">';
    for (const [id, p] of st.lanRoster) {
      const tc   = st.lanTeamColors[p.team ?? 0] ?? st.lanTeamColors[0];
      const tHex = '#' + tc.toString(16).padStart(6, '0');
      const you  = id === (st.lanNet && st.lanNet.id) ? ' (you)' : '';
      rosterHtml += `<div class="lan-waiting-player">` +
        `<span class="lan-waiting-dot" style="background:${tHex}"></span>` +
        `<span class="lan-waiting-name">${p.name || id}${you}</span>` +
        `<span class="lan-waiting-team" style="color:${tHex}">${st.lanTeamNames[p.team ?? 0]}</span>` +
        `</div>`;
    }
    rosterHtml += '</div>';
    if (isHost) {
      const canStart = st.lanRoster.size >= 2;
      rosterHtml += `<button id="lan-start-btn" class="lan-btn${canStart ? '' : ' lan-btn-disabled'}" ${canStart ? '' : 'disabled'}>Start Game</button>`;
    } else {
      rosterHtml += `<div class="lan-desc">Waiting for host to start\u2026</div>`;
    }
    rosterHtml += '</div>';
  }

  if (inRoom) {
    return `
      <div class="lan-lobby">
        ${rosterHtml}
        <div class="lan-name-row" style="margin-top:10px">
          <label class="lan-name-label">Your team</label>
          ${lanTeamSelHtml('lan-team-sel-room', st.lanMyTeam, st.lanTeamNames)}
        </div>
        <div class="lan-status">${st.lanStatus}</div>
        <div class="lan-back"><button id="lan-back-btn" class="lan-back-btn">Leave room</button></div>
      </div>`;
  }

  return onlinePreRoomHtml(st);
}

// ── Strategy purchase screen ──────────────────────────────────────────────────
export function purchaseHtml(st) {
  const roster = [
    ...FACTION_ROSTERS.american,
    ...FACTION_ROSTERS.russian,
    ...FACTION_ROSTERS.german,
  ];
  const total     = Object.values(st.purchaseSquad).reduce((s, n) => s + n, 0);
  const cost      = Object.entries(st.purchaseSquad).reduce((s, [k, n]) => s + (TANK_COSTS[k] ?? 0) * n, 0);
  const remaining = st.strategyBudget - cost;
  const canStart  = total > 0 && remaining >= 0;

  const factionHeader = key =>
    FACTION_ROSTERS.american.includes(key) ? 'ALLIES' :
    FACTION_ROSTERS.russian.includes(key)  ? 'SOVIETS' : 'AXIS';
  function bar(val, max) {
    const b = Math.min(8, Math.max(0, Math.round(val / max * 8)));
    return '\u2588'.repeat(b) + '\u2591'.repeat(8 - b);
  }

  let html = `<div class="purchase-screen">`;
  html += `<div class="purchase-info">` +
    `<span class="purchase-info-title">MISSION OBJECTIVE</span> ` +
    `Assemble your squad within the point budget, then fight to the battlefield. ` +
    `Locate the marked objective (yellow beacon), move your tanks inside the ring, and hold it until the capture bar fills. ` +
    `Defeat all enemies or complete the capture to advance to the next level.` +
    `</div>`;
  html += `<div class="purchase-budget">Budget: <span class="${remaining < 0 ? 'budget-over' : 'budget-ok'}">${remaining} pts remaining</span>  ·  ${total} tanks</div>`;
  html += `<div class="purchase-list">`;

  let lastHeader = null;
  for (let i = 0; i < roster.length; i++) {
    const key    = roster[i];
    const def    = CONFIG.TANK_DEFS[key];
    const n      = st.purchaseSquad[key] ?? 0;
    const sel    = i === st.purchaseSelIdx;
    const header = factionHeader(key);
    const canAdd = cost + TANK_COSTS[key] <= st.strategyBudget && total < 8;
    if (header !== lastHeader) {
      html += `<div class="purchase-faction-header">${header}</div>`;
      lastHeader = header;
    }
    html += `<div class="purchase-row${sel ? ' purchase-selected' : ''}" data-idx="${i}">`;
    html += `<span class="pur-name">${def.name}</span>`;
    html += `<span class="pur-stats">${bar(def.frontArmour, 100)} ARM  ${bar(def.firepower, 100)} FP  ${bar(def.maxSpeed, 56)} SPD</span>`;
    html += `<span class="pur-cost">${TANK_COSTS[key]} pts</span>`;
    html += `<span class="pur-qty">` +
      `<button class="pur-adj" data-key="${key}" data-delta="-1" ${n <= 0 ? 'disabled' : ''}>\u25C4</button>` +
      `<span class="pur-count">${n}</span>` +
      `<button class="pur-adj" data-key="${key}" data-delta="1" ${!canAdd ? 'disabled' : ''}>\u25BA</button>` +
      `</span>`;
    html += `</div>`;
  }

  html += `</div>`;
  html += `<div class="purchase-hint">Click \u25C4/\u25BA to adjust  \u00B7  Enter = START BATTLE</div>`;
  if (remaining < 0) html += `<div class="purchase-error">\u26A0 Over budget \u2014 reduce squad</div>`;
  if (total === 0)   html += `<div class="purchase-error">\u26A0 Select at least one tank</div>`;
  html += `<button class="pur-start-btn" id="pur-start-btn" ${canStart ? '' : 'disabled'}>START BATTLE</button>`;
  html += `</div>`;
  return html;
}

// ── LAN end screen (win or defeat) ────────────────────────────────────────────
export function lanEndScreenHtml(won) {
  return `
    <div class="lan-lobby">
      ${won ? '' : `<div class="lan-status" style="font-size:13px;color:rgba(255,100,80,0.85)">\u25CF Your tank was destroyed</div>`}
      <div style="display:flex;gap:10px;margin-top:8px;">
        <button id="lan-menu-btn" class="lan-btn">Main Menu</button>
        <button id="lan-lobby-btn" class="lan-btn">Online Lobby</button>
      </div>
    </div>`;
}
