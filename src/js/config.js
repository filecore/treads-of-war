// config.js — All tunable constants for Conqueror

export const CONFIG = {

  // ── Terrain ────────────────────────────────────────────────────────────────
  TILE_SIZE:      10,     // world units per tile edge (smaller = less mesh/terrain interpolation error)
  CHUNK_TILES:    8,      // tiles per chunk edge (8×8 = 64 tiles per chunk)
  VIEW_CHUNKS:    11,     // chunk grid side length (11×11 = 121 chunks visible; larger to compensate for smaller tiles)

  // Fourier terrain parameters
  // Input: world X,Z multiplied by TERRAIN_FREQ before passing to sine functions.
  // The six sine waves produce a sum in approximately ±10 range.
  // Final altitude = LAND_BASE + sum * LAND_AMP  (world units)
  TERRAIN_FREQ:   0.008,  // spatial frequency — lower = broader hills
  LAND_BASE:      20,     // mid-point altitude (world units)
  LAND_AMP:       0.55,   // world-unit gain per unit of Fourier sum (±10 range → ±5.5wu height variation)
  SEA_LEVEL:      10,     // altitudes below this are clamped to flat water

  // ── Visual ────────────────────────────────────────────────────────────────
  FOG_COLOR:      0x99AACC,  // blue sky horizon
  FOG_NEAR:       300,
  FOG_FAR:        800,

  // Flat-shaded colour palette — vivid WWII European summer landscape
  COLOURS: {
    water:       0x3366BB,   // clear blue
    waterDeep:   0x224488,
    sand:        0xC8A84A,   // sandy shoreline
    grassLight:  0x44CC33,   // bright meadow green
    grassMid:    0x33AA22,   // mid green
    grassDark:   0x558833,   // darker hilltop green
    hillScrub:   0x667744,   // scrubby upper slope
    hillRock:    0x887744,   // bare rock / worn earth
    snow:        0xDDDDCC,   // light grey-white peaks
    skyTop:      0x334488,   // deep blue sky
    skyHorizon:  0x99AACC,   // matches fog colour
    road:        0x7A7870,   // grey-brown compacted road
    treeTrunk:   0x664422,   // rich brown trunk
    treeCanopy:  0x116622,   // dark vivid forest green
    building:    0xEEDDCC,   // cream stone walls
    roof:        0xCC5520,   // terracotta-orange roof
  },

  // Directional light — "upper-left" matching original
  // This is the direction FROM the surface TOWARD the light source.
  LIGHT_DIR: { x: -0.53, y: 0.80, z: -0.27 },   // matches directional light in main.js; normalised in terrain.js
  AMBIENT_MIN: 0.55,   // darkest a face can be (ambient floor)

  // ── Tank (Phase 2) ─────────────────────────────────────────────────────────
  // Stats derived from original Archimedes binary data.
  // maxSpeed = original road speed in km/h (direct from binary; SPEED_SCALE 0.20 converts to wu/s).
  // armour / firepower = original 0–200 binary values halved to fit the 0–100 damage formula.
  // reloadTime = original binary reload-time byte ÷ 10 (seconds).
  TANK_DEFS: {
    // ── American (original roster: Chaffee, M36 90mmGMC, Sherman Firefly, Pershing)
    // All armour values = original binary ÷ 2.  xcSpeed = binary off-road km/h.
    m24:      { name:'M24 Chaffee',     faction:'american', maxSpeed:56, xcSpeed:40, accel:45, turnRate:60, frontArmour:20, sideArmour:10, rearArmour:10, firepower:35, reloadTime:0.9, turretSpeed:70, accuracy:70, cost:100, modelScale:0.85 },
    m36:      { name:'M36 90mmGMC',     faction:'american', maxSpeed:48, xcSpeed:29, accel:36, turnRate:52, frontArmour:30, sideArmour:11, rearArmour:10, firepower:68, reloadTime:0.9, turretSpeed:55, accuracy:68, cost:220, modelScale:1.0  },
    sherman:  { name:'Sherman Firefly', faction:'american', maxSpeed:40, xcSpeed:25, accel:37, turnRate:45, frontArmour:47, sideArmour:19, rearArmour:19, firepower:61, reloadTime:1.3, turretSpeed:48, accuracy:65, cost:300, modelScale:1.0  },
    pershing: { name:'M26 Pershing',    faction:'american', maxSpeed:32, xcSpeed:20, accel:31, turnRate:35, frontArmour:60, sideArmour:38, rearArmour:26, firepower:68, reloadTime:1.3, turretSpeed:40, accuracy:65, cost:380, modelScale:1.15 },
    // ── German (original roster: Panzer III, Panther, Tiger I, King Tiger)
    pz3:      { name:'Panzer III',      faction:'german',   maxSpeed:40, xcSpeed:25, accel:46, turnRate:55, frontArmour:28, sideArmour:15, rearArmour:20, firepower:30, reloadTime:1.6, turretSpeed:65, accuracy:65, cost:100, modelScale:0.85 },
    panther:  { name:'Panther',         faction:'german',   maxSpeed:46, xcSpeed:25, accel:32, turnRate:48, frontArmour:60, sideArmour:29, rearArmour:23, firepower:62, reloadTime:1.6, turretSpeed:50, accuracy:70, cost:350, modelScale:1.1  },
    tiger:    { name:'Tiger I',         faction:'german',   maxSpeed:38, xcSpeed:20, accel:35, turnRate:35, frontArmour:55, sideArmour:40, rearArmour:40, firepower:55, reloadTime:2.5, turretSpeed:35, accuracy:68, cost:450, modelScale:1.2  },
    kingtiger:{ name:'King Tiger',      faction:'german',   maxSpeed:35, xcSpeed:20, accel:14, turnRate:25, frontArmour:100,sideArmour:45, rearArmour:45, firepower:93, reloadTime:4.0, turretSpeed:28, accuracy:65, cost:600, modelScale:1.35 },
    // ── Russian (original roster: T-34/76, KV-1S, KV-85, JS-II)
    t34:      { name:'T-34/76',         faction:'russian',  maxSpeed:55, xcSpeed:38, accel:37, turnRate:58, frontArmour:37, sideArmour:30, rearArmour:20, firepower:35, reloadTime:3.0, turretSpeed:62, accuracy:62, cost:150, modelScale:1.0  },
    kv1s:     { name:'KV-1S',           faction:'russian',  maxSpeed:45, xcSpeed:30, accel:39, turnRate:42, frontArmour:43, sideArmour:30, rearArmour:20, firepower:35, reloadTime:3.0, turretSpeed:52, accuracy:58, cost:250, modelScale:1.2  },
    kv85:     { name:'KV-85',           faction:'russian',  maxSpeed:40, xcSpeed:26, accel:37, turnRate:40, frontArmour:43, sideArmour:30, rearArmour:20, firepower:48, reloadTime:3.0, turretSpeed:45, accuracy:60, cost:300, modelScale:1.2  },
    js2:      { name:'JS-II',           faction:'russian',  maxSpeed:37, xcSpeed:20, accel:22, turnRate:32, frontArmour:93, sideArmour:48, rearArmour:30, firepower:73, reloadTime:3.0, turretSpeed:40, accuracy:58, cost:500, modelScale:1.35 },
    // ── Mercenaries (stats averaged from same-class counterparts of all 3 factions)
    marauder:   { name:'Marauder Mk II', faction:'mercenary', maxSpeed:50, xcSpeed:34, accel:43, turnRate:58, frontArmour:28, sideArmour:18, rearArmour:17, firepower:33, reloadTime:1.8, turretSpeed:66, accuracy:66, cost:150, modelScale:0.9  },
    interceptor:{ name:'Interceptor',    faction:'mercenary', maxSpeed:46, xcSpeed:28, accel:36, turnRate:47, frontArmour:44, sideArmour:23, rearArmour:18, firepower:55, reloadTime:1.8, turretSpeed:52, accuracy:65, cost:300, modelScale:1.05 },
    vulture:    { name:'Vulture Type I', faction:'mercenary', maxSpeed:39, xcSpeed:24, accel:36, turnRate:40, frontArmour:48, sideArmour:30, rearArmour:26, firepower:55, reloadTime:2.3, turretSpeed:43, accuracy:64, cost:420, modelScale:1.1  },
    obliterator:{ name:'Obliterator IV', faction:'mercenary', maxSpeed:56, xcSpeed:35, accel:40, turnRate:60, frontArmour:100,sideArmour:100,rearArmour:100,firepower:100,reloadTime:0.5, turretSpeed:100,accuracy:100,cost:800, modelScale:1.25 },
  },

  // ── Map boundary ───────────────────────────────────────────────────────────
  MAP_HALF:       325,    // game area extends ±MAP_HALF world units from origin

  // ── Difficulty presets ─────────────────────────────────────────────────────
  // turretSpeedMult: multiplier on turret rotation rate
  // playerDmgMult:   multiplier on damage the player receives
  DIFFICULTY_PRESETS: {
    easy:   { detectRange: 150, engageRange:  70, disengageRange: 220, aimTolerance: 0.55, fireInterval: 7.0, fireRandExtra: 5.0, turretSpeedMult: 0.30, playerDmgMult: 0.45 },
    normal: { detectRange: 200, engageRange:  90, disengageRange: 290, aimTolerance: 0.38, fireInterval: 6.0, fireRandExtra: 5.0, turretSpeedMult: 0.55, playerDmgMult: 0.75 },
    medium: { detectRange: 250, engageRange: 110, disengageRange: 340, aimTolerance: 0.25, fireInterval: 3.0, fireRandExtra: 2.5, turretSpeedMult: 0.85, playerDmgMult: 1.00 },
    hard:   { detectRange: 300, engageRange: 130, disengageRange: 390, aimTolerance: 0.18, fireInterval: 2.3, fireRandExtra: 2.0, turretSpeedMult: 1.05, playerDmgMult: 1.20 },
  },

  // ── Physics (Phase 2) ──────────────────────────────────────────────────────
  GRAVITY:        9.81,
  SHELL_GRAVITY:  9.81,
  FRICTION:       0.82,   // velocity multiplier per frame when no input (snappier stop for arcade feel)
};

// Active difficulty settings — mutable, updated by the UI slider. Default: Normal.
export const DIFFICULTY = { ...CONFIG.DIFFICULTY_PRESETS.normal };
