// modes.js — Game mode definitions: Arcade, Attrition, Strategy
//
// Data cross-referenced from original binary (!RunImage,8000-ef4c):
//   - Budget table at 0x080C0: 1000, 2000, 3375, 3000, 4000, 5000, 6000
//   - "sparelives" sprite at 0x159C4 confirms 3 starting lives
//   - Kill threshold to upgrade: estimated 4 kills from review descriptions
//   - Tank costs scaled to budget range from stat records at 0x0BB8

export const MODES = Object.freeze({
  ARCADE:    'ARCADE',
  ATTRITION: 'ATTRITION',
  STRATEGY:  'STRATEGY',
});

// ── Arcade mode ───────────────────────────────────────────────────────────────
// Player upgrades through 4 tank classes after KILLS_TO_UPGRADE kills each.
// Class 3 (heavy) is endless — each new wave adds 2 more enemies.
export const KILLS_TO_UPGRADE = 4;

export const ARCADE_CLASSES = [
  // class 0: light (intro) — 2 waves to upgrade (2+2 = 4 kills)
  { american: 'm24',      russian: 't34',   german: 'pz3',       mercenary: 'marauder',    allyEnemy: 'pz3',       axisEnemies: ['m24', 't34'],        count: 2 },
  // class 1: medium — 2 waves to upgrade (3+1 = 4 kills, upgrade mid-wave 2)
  { american: 'm36',      russian: 'kv1s',  german: 'panther',   mercenary: 'interceptor', allyEnemy: 'panther',   axisEnemies: ['m36', 'kv1s'],       count: 3 },
  // class 2: medium-heavy — 1 wave to upgrade (4 kills exactly)
  { american: 'sherman',  russian: 'kv85',  german: 'tiger',     mercenary: 'vulture',     allyEnemy: 'tiger',     axisEnemies: ['sherman', 'kv85'],   count: 4 },
  // class 3: heavy (endless — count increases by 1 each wave: 3, 4, 5, 6...)
  // Germany faces KV-85 + Pershing (not JS-II) to give King Tiger a fighting chance
  { american: 'pershing', russian: 'js2',   german: 'kingtiger', mercenary: 'obliterator', allyEnemy: 'kingtiger', axisEnemies: ['kv85', 'pershing'],  count: 3 },
];

// ── Attrition mode ────────────────────────────────────────────────────────────
// Player receives a fixed squad at the start that is NEVER replenished.
// Destroyed tanks are gone permanently. Escalating enemy per battle.
export const ATTRITION_PLAYER_SQUADS = {
  american: ['m24', 'm24', 'sherman', 'sherman', 'pershing'],
  russian:  ['t34', 't34', 'kv85',   'kv85',    'js2'     ],
  german:   ['pz3', 'pz3', 'panther', 'tiger',   'kingtiger'],
  mercenary:['marauder', 'marauder', 'interceptor', 'vulture', 'obliterator'],
};

// Enemy squads escalate each battle; last entry reused for battle 4+
// 'allies' = German player faces Allied/Soviet enemies; 'german' = Allied/Soviet player faces German enemies
export const ATTRITION_ENEMY_SQUADS = {
  german: [
    ['pz3', 'pz3', 'pz3', 'panther'],
    ['pz3', 'pz3', 'panther', 'panther', 'tiger'],
    ['pz3', 'panther', 'panther', 'tiger', 'tiger', 'kingtiger'],
    ['panther', 'tiger', 'tiger', 'kingtiger', 'kingtiger', 'kingtiger', 'kingtiger'],
  ],
  allies: [
    ['m24', 't34', 'm24', 'sherman'],
    ['m24', 't34', 'sherman', 'kv85', 'pershing'],
    ['m24', 'sherman', 'kv85', 'pershing', 'js2', 'pershing'],
    ['sherman', 'pershing', 'kv85', 'js2', 'pershing', 'js2', 'pershing'],
  ],
};

// ── Strategy mode ─────────────────────────────────────────────────────────────
// Both sides start with a budget; player purchases squad before each battle.
// Budget progression from binary at 0x080C0.
export const STRATEGY_BUDGETS = [1000, 2000, 3375, 3000, 4000, 5000, 6000];

// Tank costs in strategy budget units
export const TANK_COSTS = {
  m24:      80,
  m36:     180,
  sherman:  220,
  pershing: 400,
  t34:      120,
  kv1s:     160,
  kv85:     220,
  js2:      480,
  pz3:       80,
  panther:   240,
  tiger:     360,
  kingtiger: 520,
  marauder:    120,
  interceptor: 280,
  vulture:     400,
  obliterator: 800,
};

// Purchasable tank rosters per faction
export const FACTION_ROSTERS = {
  american: ['m24', 'm36', 'sherman', 'pershing'],
  russian:  ['t34', 'kv1s', 'kv85', 'js2'],
  german:   ['pz3', 'panther', 'tiger', 'kingtiger'],
  mercenary:['marauder', 'interceptor', 'vulture', 'obliterator'],
};

// Objective capture: hold this many seconds continuously to win
export const OBJECTIVE_HOLD_REQ  = 60;
export const OBJECTIVE_RADIUS     = 18;  // world units — tank must be inside to hold
export const OBJECTIVE_CONTEST_R  = 35;  // enemy within this range cancels hold
