// config.js — All tunable constants for Treads of War

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
  SEA_LEVEL:      16.3,   // altitudes below this are clamped to flat water (within actual terrain range 14.5–25.5)

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
    skyTop:      0x4488CC,   // vivid medium blue sky
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
    m24:      { name:'M24 Chaffee',     faction:'american', maxSpeed:62, xcSpeed:44, accel:45, turnRate:60, frontArmour:20, sideArmour:10, rearArmour:10, firepower:35, reloadTime:0.9, turretSpeed:70, accuracy:70, cost:100, modelScale:0.85, slopeBonus:0 },
    m36:      { name:'M36 90mmGMC',     faction:'american', maxSpeed:53, xcSpeed:32, accel:36, turnRate:52, frontArmour:30, sideArmour:11, rearArmour:10, firepower:68, reloadTime:0.9, turretSpeed:55, accuracy:68, cost:220, modelScale:1.0,  slopeBonus:0 },
    sherman:  { name:'Sherman Firefly', faction:'american', maxSpeed:44, xcSpeed:28, accel:37, turnRate:45, frontArmour:47, sideArmour:19, rearArmour:19, firepower:61, reloadTime:1.3, turretSpeed:48, accuracy:65, cost:300, modelScale:1.0,  slopeBonus:3 },
    pershing: { name:'M26 Pershing',    faction:'american', maxSpeed:35, xcSpeed:22, accel:31, turnRate:35, frontArmour:60, sideArmour:38, rearArmour:26, firepower:68, reloadTime:1.3, turretSpeed:40, accuracy:65, cost:380, modelScale:1.15, slopeBonus:3 },
    // ── German (original roster: Panzer III, Panther, Tiger I, King Tiger)
    pz3:      { name:'Panzer III',      faction:'german',   maxSpeed:44, xcSpeed:28, accel:46, turnRate:55, frontArmour:28, sideArmour:15, rearArmour:20, firepower:30, reloadTime:1.6, turretSpeed:65, accuracy:65, cost:100, modelScale:0.85, slopeBonus:0 },
    panther:  { name:'Panther',         faction:'german',   maxSpeed:51, xcSpeed:28, accel:32, turnRate:48, frontArmour:60, sideArmour:29, rearArmour:23, firepower:62, reloadTime:1.6, turretSpeed:50, accuracy:70, cost:350, modelScale:1.1,  slopeBonus:6 },
    tiger:    { name:'Tiger I',         faction:'german',   maxSpeed:42, xcSpeed:22, accel:35, turnRate:35, frontArmour:55, sideArmour:40, rearArmour:40, firepower:55, reloadTime:2.5, turretSpeed:35, accuracy:68, cost:450, modelScale:1.2,  slopeBonus:0 },
    kingtiger:{ name:'King Tiger',      faction:'german',   maxSpeed:39, xcSpeed:22, accel:14, turnRate:25, frontArmour:100,sideArmour:45, rearArmour:45, firepower:93, reloadTime:4.0, turretSpeed:28, accuracy:65, cost:600, modelScale:1.35, slopeBonus:5 },
    // ── Russian (original roster: T-34/76, KV-1S, KV-85, JS-II)
    t34:      { name:'T-34/76',         faction:'russian',  maxSpeed:61, xcSpeed:42, accel:37, turnRate:58, frontArmour:37, sideArmour:30, rearArmour:20, firepower:35, reloadTime:3.0, turretSpeed:62, accuracy:62, cost:150, modelScale:1.0,  slopeBonus:8 },
    kv1s:     { name:'KV-1S',           faction:'russian',  maxSpeed:50, xcSpeed:33, accel:39, turnRate:42, frontArmour:43, sideArmour:30, rearArmour:20, firepower:35, reloadTime:3.0, turretSpeed:52, accuracy:58, cost:250, modelScale:1.2,  slopeBonus:0 },
    kv85:     { name:'KV-85',           faction:'russian',  maxSpeed:44, xcSpeed:29, accel:37, turnRate:40, frontArmour:43, sideArmour:30, rearArmour:20, firepower:48, reloadTime:3.0, turretSpeed:45, accuracy:60, cost:300, modelScale:1.2,  slopeBonus:0 },
    js2:      { name:'JS-II',           faction:'russian',  maxSpeed:41, xcSpeed:22, accel:22, turnRate:32, frontArmour:93, sideArmour:48, rearArmour:30, firepower:73, reloadTime:3.0, turretSpeed:40, accuracy:58, cost:500, modelScale:1.35, slopeBonus:6 },
    // ── Mercenaries (stats averaged from same-class counterparts of all 3 factions)
    marauder:   { name:'Marauder Mk II', faction:'mercenary', maxSpeed:55, xcSpeed:37, accel:43, turnRate:58, frontArmour:28, sideArmour:18, rearArmour:17, firepower:33, reloadTime:1.8, turretSpeed:66, accuracy:66, cost:150, modelScale:0.9,  slopeBonus:0 },
    interceptor:{ name:'Interceptor',    faction:'mercenary', maxSpeed:51, xcSpeed:31, accel:36, turnRate:47, frontArmour:44, sideArmour:23, rearArmour:18, firepower:55, reloadTime:1.8, turretSpeed:52, accuracy:65, cost:300, modelScale:1.05, slopeBonus:0 },
    vulture:    { name:'Vulture Type I', faction:'mercenary', maxSpeed:43, xcSpeed:26, accel:36, turnRate:40, frontArmour:48, sideArmour:30, rearArmour:26, firepower:55, reloadTime:2.3, turretSpeed:43, accuracy:64, cost:420, modelScale:1.1,  slopeBonus:0 },
    obliterator:{ name:'Obliterator IV', faction:'mercenary', maxSpeed:62, xcSpeed:39, accel:40, turnRate:60, frontArmour:100,sideArmour:100,rearArmour:100,firepower:100,reloadTime:0.5, turretSpeed:100,accuracy:100,cost:800, modelScale:1.25, slopeBonus:0 },
  },

  // ── Map boundary ───────────────────────────────────────────────────────────
  MAP_HALF:       325,    // game area extends ±MAP_HALF world units from origin

  // ── Difficulty presets ─────────────────────────────────────────────────────
  // turretSpeedMult:    multiplier on AI turret rotation rate
  // playerDmgMult:      multiplier on damage the player receives
  // reloadMult:         player reload speed (0.65 = 35% faster, 0.75 = 25% faster, etc.)
  // reactionDelay:      seconds before AI turret starts tracking on target acquisition
  // aimAssistStrength:  per-second yaw-correction fraction for auto-turret assist
  // waveRepairHp:       HP restored between Arcade waves (R to continue)
  DIFFICULTY_PRESETS: {
    easy:   { detectRange: 158, engageRange:  40, disengageRange: 230, aimTolerance: 0.55, fireInterval: 6.0, fireRandExtra: 3.0, turretSpeedMult: 0.30, playerDmgMult: 0.50, reloadMult: 0.65, reactionDelay: 1.8, aimAssistStrength: 0.40, waveRepairHp: 50 },
    normal: { detectRange: 225, engageRange:  60, disengageRange: 333, aimTolerance: 0.35, fireInterval: 4.0, fireRandExtra: 2.0, turretSpeedMult: 0.55, playerDmgMult: 0.75, reloadMult: 0.75, reactionDelay: 1.2, aimAssistStrength: 0.25, waveRepairHp: 30 },
    medium: { detectRange: 293, engageRange:  73, disengageRange: 413, aimTolerance: 0.22, fireInterval: 3.0, fireRandExtra: 1.5, turretSpeedMult: 0.80, playerDmgMult: 1.00, reloadMult: 0.75, reactionDelay: 0.7, aimAssistStrength: 0.20, waveRepairHp: 20 },
    hard:   { detectRange: 360, engageRange:  93, disengageRange: 495, aimTolerance: 0.12, fireInterval: 2.0, fireRandExtra: 1.0, turretSpeedMult: 1.10, playerDmgMult: 1.15, reloadMult: 0.85, reactionDelay: 0.3, aimAssistStrength: 0.10, waveRepairHp: 10 },
  },

  // ── Physics (Phase 2) ──────────────────────────────────────────────────────
  GRAVITY:        9.81,
  SHELL_GRAVITY:  9.81,
  FRICTION:       0.82,   // velocity multiplier per frame when no input (snappier stop for arcade feel)

  // ── Camera ─────────────────────────────────────────────────────────────────
  CAMERA_FOV:     60,     // main camera field of view (degrees)
  SIGHT_FOV:      14,     // gun-sight zoom FOV (degrees)
  CAM_BEHIND:     25,     // units behind tank (third-person follow)
  CAM_UP:         12,     // units above terrain (follow height)
  CAM_LOOK_FWD:   4,      // look-at point offset ahead of tank (world units)
  CAM_LOOK_Y:     2.0,    // look-at point Y offset above tank centre

  // ── Performance & input ────────────────────────────────────────────────────
  PIXEL_RATIO_CAP: 2,     // max devicePixelRatio used by renderer
  ASSIST_RANGE:    80,    // aim-assist acquisition range (world units)
};

// Active difficulty settings — mutable, updated by the UI slider. Default: Normal.
export const DIFFICULTY = { ...CONFIG.DIFFICULTY_PRESETS.normal };
