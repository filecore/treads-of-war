// main.js — Phase 5: Game states (menu / playing / paused / game-over / victory)

import * as THREE from 'three';
import { CONFIG }         from './config.js';
import { ChunkManager, getAltitude, setTerrainOffset, setTerrainWaterEnabled } from './terrain.js';
import { Input }          from './input.js';
import { Tank }           from './tank.js';
import { buildAuthenticModel } from './models.js';
import { CombatManager, ballisticElevation }  from './combat.js';
import { ParticleSystem } from './particles.js';
import { AIController, WingmanController } from './ai.js';
import { GameManager, STATES } from './game.js';
import {
  MODES, KILLS_TO_UPGRADE, ARCADE_CLASSES,
  ATTRITION_PLAYER_SQUADS, ATTRITION_ENEMY_SQUADS,
  STRATEGY_BUDGETS, TANK_COSTS, FACTION_ROSTERS,
  OBJECTIVE_HOLD_REQ, OBJECTIVE_RADIUS, OBJECTIVE_CONTEST_R,
} from './modes.js';
import { AudioManager }        from './audio.js';
import { DIFFICULTY }          from './config.js';
import { WeatherManager } from './weather.js';
import { CTFManager, CTF_CARRIER_SPEED, CTF_RESPAWN_SECS, FLAG_COLORS, FLAG_NAMES } from './ctf.js';
import { Net, LAN_SNAP_HZ }   from './net.js';

// ─── Gameplay constants ───────────────────────────────────────────────────────
const COLL_DAMP          = 0.55; // speed multiplier applied to both tanks on collision
// Reload and aim-assist strength are now difficulty-driven (DIFFICULTY.reloadMult / .aimAssistStrength)
const DEATH_CAM_DURATION = 4.0;  // seconds of death-camera orbit before overlay appears
const DEATH_CAM_SPEED    = 0.35; // radians per second — orbit rotation speed
const DEATH_CAM_RADIUS   = 30;   // world units — orbit radius around wreck
const DEATH_CAM_HEIGHT   = 18;   // world units above wreck
// SIGHT_FOV / ASSIST_RANGE live in config.js (CONFIG.SIGHT_FOV / CONFIG.ASSIST_RANGE)
const SIGHT_YAW_SENS     = 0.0018; // turret rad per mouse pixel in sight mode
const SIGHT_ELEV_SENS    = 0.0012; // elevation rad per mouse pixel in sight mode
const ELEV_MIN           = -0.08;  // ~-4.6° gun depression
const ELEV_MAX           =  0.42;  // ~24° maximum elevation
const SHAKE_DECAY        = 9;    // camera shake magnitude decay per second
const HE_SPLASH_R        = 18;   // world units — HE blast radius
const HE_SPLASH_DMG      = 30;   // max splash damage at ground zero
const ARTY_CHARGES       = 2;    // artillery barrages per wave
const ARTY_DELAY         = 1.8;  // seconds from call to first impact
const ARTY_SHELLS        = 6;    // shells per barrage
const ARTY_SPREAD        = 22;   // world units — spread radius around target
const ARTY_BLAST_R       = 11;   // world units — per-shell blast radius
const ARTY_BLAST_DMG     = 30;   // max damage per shell at ground zero
const TREE_COLL_R        = 1.6;  // tree trunk collision radius (world units)
const PASSBY_R           = 20;   // world units — enemy shell pass-by sound trigger radius
const CRATE_COLLECT_R    = 5;    // world units — collection radius
const WRECK_RECOVER_R    = 5;    // world units — recovery activation range
const WRECK_PROMPT_R     = 8;    // world units — show "hold position" prompt
const WRECK_LABEL_R      = 80;   // world units — show RECOVERABLE label
const WRECK_RECOVER_T    = 12;   // seconds to complete recovery
const WRECK_OVERKILL_PCT = 0.30; // fraction of maxHp — catastrophic kill threshold
const SMOKE_COUNT        = 3;    // smoke grenades replenished each wave
const SMOKE_PUFF_R       = 11;   // cloud radius at full size (world units)
const SMOKE_LIFE         = 14;   // seconds cloud persists after deploying
const SMOKE_EXPAND       = 2.5;  // seconds to reach full radius
const SMOKE_FADE         = 4.0;  // seconds of fade-out at end of life
const SPOTTER_CHARGES    = 2;    // spotter plane calls per battle (Strategy only)
const SPOTTER_DURATION   = 25;   // seconds enemy positions remain visible after spotting

// ─── Scene ────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(CONFIG.FOG_COLOR, CONFIG.FOG_NEAR, CONFIG.FOG_FAR);

// ─── Sky gradient dome ────────────────────────────────────────────────────────
// Vertex-coloured sphere rendered inside-out, follows camera to always surround
// the player. Gradient from skyTop (zenith) to skyHorizon (equator) matches fog.
const _skyR   = CONFIG.FOG_FAR * 0.88;
const _skyGeo = new THREE.SphereGeometry(_skyR, 16, 8);
{
  const topC   = new THREE.Color(CONFIG.COLOURS.skyTop);
  const horizC = new THREE.Color(CONFIG.COLOURS.skyHorizon);
  const cnt    = _skyGeo.attributes.position.count;
  const cols   = new Float32Array(cnt * 3);
  for (let i = 0; i < cnt; i++) {
    const y = _skyGeo.attributes.position.getY(i);
    const t = THREE.MathUtils.clamp(y / _skyR, 0, 1);
    const c = horizC.clone().lerp(topC, t);
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  _skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
}
const _sky = new THREE.Mesh(_skyGeo,
  new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
_sky.renderOrder = -1;
scene.add(_sky);

// ─── Weather ──────────────────────────────────────────────────────────────────
const weather = new WeatherManager(scene);

// ─── Renderer ─────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 1);   // black fallback — masked by sky sphere in practice
document.getElementById('canvas-wrap').appendChild(renderer.domElement);

// ─── Camera ───────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, CONFIG.FOG_FAR + 50);
// Elevated menu position — overridden by tank camera during gameplay
camera.position.set(0, 120, 90);
camera.lookAt(0, 20, 0);
weather.setCamera(camera);

// ─── Lighting ─────────────────────────────────────────────────────────────────
// Scene lights drive Lambert objects (trees, roads, roofs) only — tanks are self-lit via baked vertex colours.
// Directional kept at reduced intensity so Lambert objects get mild directional shading.
const sun = new THREE.DirectionalLight(0xFFFFFF, 0.7);
sun.position.set(-1, 1.5, -0.5);
scene.add(sun);
const ambLight = new THREE.AmbientLight(0x606070, 0.9);  // generous ambient so Lambert faces are readable
scene.add(ambLight);

// ─── Tank selection preview renderer ─────────────────────────────────────────
// A separate small renderer draws the selected tank into the #tank-preview canvas.
const _prevCanvas = document.getElementById('tank-preview');
const _prevRenderer = _prevCanvas
  ? new THREE.WebGLRenderer({ canvas: _prevCanvas, antialias: true })
  : null;
if (_prevRenderer) {
  _prevRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _prevRenderer.setClearColor(0x353539, 1);   // dark grey — contrasts with all faction colours and dark barrel
}

const _prevScene  = new THREE.Scene();
const _prevCamera = new THREE.PerspectiveCamera(38, 220 / 160, 0.5, 500);
// Camera angle: elevated front-left, looking at origin
_prevCamera.position.set(-12, 8, 12);
_prevCamera.lookAt(0, 1, 0);
_prevScene.add(new THREE.HemisphereLight(0xaabbdd, 0x334422, 0.7));
const _prevSun = new THREE.DirectionalLight(0xfff0cc, 1.1);
_prevSun.position.set(-3, 5, 4);
_prevScene.add(_prevSun);

let _prevMeshRoot = null;   // current tank group in preview scene
let _prevAngle    = 0;      // slow auto-rotation angle

function _buildPreview(tankKey) {
  if (!_prevRenderer) return;
  if (_prevMeshRoot) {
    _prevScene.remove(_prevMeshRoot);
    // Dispose geometries/materials inside group
    _prevMeshRoot.traverse(o => {
      if (o.isMesh) { o.geometry.dispose(); }
    });
    _prevMeshRoot = null;
  }
  const def    = CONFIG.TANK_DEFS[tankKey];
  const vis    = tankKey === 'obliterator' ? _getMercObliteratorStats() : null;
  const built  = buildAuthenticModel(def, tankKey, false, null, vis);
  _prevMeshRoot = built.grp;
  // Scale/centre preview: fit to roughly ±3 world units
  const s = 2.5 / (def.modelScale || 1);
  _prevMeshRoot.scale.setScalar(s);
  _prevMeshRoot.position.set(0, 0, 0);
  _prevAngle = 0;
  _prevScene.add(_prevMeshRoot);
}

// ─── Terrain ──────────────────────────────────────────────────────────────────
const chunkManager = new ChunkManager(scene);
// Initial update deferred until after roads are built so the road filter is available.

// ─── Shell craters — surface decals ───────────────────────────────────────────
// Craters are purely visual meshes drawn ON TOP of the terrain surface.
// The terrain geometry is never modified. Tanks drive over craters with no
// physics interaction. clearCraters() disposes and removes all decal meshes.
const _craterDecals = [];  // THREE.Mesh[]

function _createCraterDecal(cx, cz, baseRadius) {
  if (_waterAt(cx, cz).onPond) return null;
  const segments = 12;
  const rings    = 4;
  const positions = [];
  const colors    = [];

  // Irregular outer edge — each radial spoke gets a random radius multiplier
  const edgeNoise = [];
  for (let s = 0; s <= segments; s++) {
    edgeNoise.push(0.7 + Math.random() * 0.6);  // 70 – 130 % of baseRadius
  }

  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a0 = (s       / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;

      const rInner = (r       / rings) * baseRadius;
      const rOuter = ((r + 1) / rings) * baseRadius;

      const n0 = edgeNoise[s];
      const n1 = edgeNoise[s + 1];

      const corners = [
        { x: cx + Math.cos(a0) * rInner * n0, z: cz + Math.sin(a0) * rInner * n0 },
        { x: cx + Math.cos(a0) * rOuter * n0, z: cz + Math.sin(a0) * rOuter * n0 },
        { x: cx + Math.cos(a1) * rOuter * n1, z: cz + Math.sin(a1) * rOuter * n1 },
        { x: cx + Math.cos(a1) * rInner * n1, z: cz + Math.sin(a1) * rInner * n1 },
      ];

      // Y: sits just above the terrain surface — no depth modification
      for (const c of corners) {
        c.y = getAltitude(c.x, c.z) + 0.05;
      }

      // Colour: simulate depth via shading only
      // Centre rings = dark charcoal (looks deep); outer rim = lighter grey-brown
      const ringT = r / rings;  // 0 = centre, approaching 1 = outer edge
      let cr, cg, cb;
      if      (ringT < 0.25) { cr = 0.06; cg = 0.05; cb = 0.04; }  // scorched floor
      else if (ringT < 0.50) { cr = 0.14; cg = 0.11; cb = 0.08; }  // inner slope
      else if (ringT < 0.75) { cr = 0.22; cg = 0.18; cb = 0.12; }  // outer slope
      else                   { cr = 0.30; cg = 0.25; cb = 0.16; }  // rim

      // Per-face random variation breaks the bullseye look
      const noise = 0.8 + Math.random() * 0.4;
      const col = new THREE.Color(cr * noise, cg * noise, cb * noise);

      // Two triangles per quad
      for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) {
        for (const idx of [a, b, c]) {
          positions.push(corners[idx].x, corners[idx].y, corners[idx].z);
          colors.push(col.r, col.g, col.b);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors,    3));

  const decal = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors:        true,
    side:                THREE.DoubleSide,
    depthTest:           true,
    depthWrite:          false,
    polygonOffset:       true,
    polygonOffsetFactor: -0.5,
    polygonOffsetUnits:  -1,
  }));
  decal.renderOrder = 1;   // render after tanks (renderOrder 0) so depth test hides crater under hulls
  return decal;
}

function addCrater(cx, cz, sizeMult = 1.0) {
  const baseRadius = (3.4 + Math.random() * 1.4) * sizeMult;
  const decal = _createCraterDecal(cx, cz, baseRadius);
  if (!decal) return;
  scene.add(decal);
  _craterDecals.push(decal);
}

// Special burn-scar crater placed under a destroyed tank hull.
// 50% larger than a standard crater; pure-black centre fading to dark char-brown.
function addDeathCrater(cx, cz) {
  if (_waterAt(cx, cz).onPond) return;
  const baseRadius = (3.4 + Math.random() * 1.4) * 1.5;
  const segments = 12;
  const rings    = 4;
  const positions = [];
  const colors    = [];

  const edgeNoise = [];
  for (let s = 0; s <= segments; s++) edgeNoise.push(0.7 + Math.random() * 0.6);

  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a0 = (s       / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;
      const rInner = (r       / rings) * baseRadius;
      const rOuter = ((r + 1) / rings) * baseRadius;
      const n0 = edgeNoise[s], n1 = edgeNoise[s + 1];
      const corners = [
        { x: cx + Math.cos(a0) * rInner * n0, z: cz + Math.sin(a0) * rInner * n0 },
        { x: cx + Math.cos(a0) * rOuter * n0, z: cz + Math.sin(a0) * rOuter * n0 },
        { x: cx + Math.cos(a1) * rOuter * n1, z: cz + Math.sin(a1) * rOuter * n1 },
        { x: cx + Math.cos(a1) * rInner * n1, z: cz + Math.sin(a1) * rInner * n1 },
      ];
      for (const c of corners) c.y = getAltitude(c.x, c.z) + 0.05;

      // Centre = pure black; outer edge = dark char-brown — much darker than a regular crater
      const ringT = r / rings;
      let cr, cg, cb;
      if      (ringT < 0.25) { cr = 0.00; cg = 0.00; cb = 0.00; }  // pure black core
      else if (ringT < 0.50) { cr = 0.03; cg = 0.02; cb = 0.01; }  // near-black char
      else if (ringT < 0.75) { cr = 0.08; cg = 0.05; cb = 0.01; }  // dark char
      else                   { cr = 0.22; cg = 0.13; cb = 0.04; }  // outer char-brown

      const noise = 0.8 + Math.random() * 0.4;
      const col = new THREE.Color(cr * noise, cg * noise, cb * noise);
      for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) {
        for (const idx of [a, b, c]) {
          positions.push(corners[idx].x, corners[idx].y, corners[idx].z);
          colors.push(col.r, col.g, col.b);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors,    3));
  const decal = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide,
    depthTest: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -0.5, polygonOffsetUnits: -1,
  }));
  decal.renderOrder = 1;
  scene.add(decal);
  _craterDecals.push(decal);
}

function clearCraters() {
  for (const decal of _craterDecals) {
    scene.remove(decal);
    decal.geometry.dispose();
    decal.material.dispose();
  }
  _craterDecals.length = 0;
}

// Clear all per-battle debris (craters, burners, smokers) between rounds.
// Called before spawning each new wave/battle to keep draw-call count bounded.
function clearBattleDebris() {
  clearCraters();
  particles.dispose();   // disposes all burners and smokers (including wreck smokers)
  _npcSmokers.clear();   // stale tank references removed; new smokers will be created on demand
  _clearWrecks();
}

function _clearWrecks() {
  for (const w of _wrecks) {
    if (w.labelEl) w.labelEl.remove();
    if (w.ringMesh) {
      scene.remove(w.ringMesh);
      w.ringMesh.geometry.dispose();
      w.ringMesh.material.dispose();
    }
  }
  _wrecks.length = 0;
  _recoveringWreck = null;
  _recoveryTimer   = 0;
  if (_hudRecoveryBar)    _hudRecoveryBar.style.display    = 'none';
  if (_hudRecoveryPrompt) _hudRecoveryPrompt.style.display = 'none';
}

// ─── Boundary walls ───────────────────────────────────────────────────────────
// Dark solid planes just outside MAP_HALF create a "world vanishes into darkness"
// effect. Wireframe grid walls are hidden by default and only shown when the player
// is within 2% of the map edge.
const _boundaryWalls = [];
{
  const M    = CONFIG.MAP_HALF;
  const W    = M * 2 + 600;   // wide enough to cover corners from any angle
  const H    = 180;
  const half = H / 2;

  // Solid dark void planes — sit just beyond the boundary, fog blends them naturally
  const voidMat = new THREE.MeshBasicMaterial({ color: 0x040810, side: THREE.DoubleSide });
  const voidDefs = [
    { x:  0,   z: -(M + 1), ry:  0 },
    { x:  0,   z:  (M + 1), ry:  Math.PI },
    { x: -(M + 1), z: 0,    ry:  Math.PI / 2 },
    { x:  (M + 1), z: 0,    ry: -Math.PI / 2 },
  ];
  for (const d of voidDefs) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H), voidMat);
    m.position.set(d.x, half, d.z);
    m.rotation.y = d.ry;
    scene.add(m);
  }

  // Wireframe grid walls — hidden by default, revealed only when close to edge
  const gridMat = new THREE.MeshBasicMaterial({
    color: 0x3366cc, wireframe: true, transparent: true, opacity: 0.40,
    side: THREE.DoubleSide,
  });
  const gridDefs = [
    { x:  0, z: -M, ry:  0 },
    { x:  0, z:  M, ry:  Math.PI },
    { x: -M, z:  0, ry:  Math.PI / 2 },
    { x:  M, z:  0, ry: -Math.PI / 2 },
  ];
  for (const d of gridDefs) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(M * 2, 100, 20, 20), gridMat);
    m.position.set(d.x, 50, d.z);
    m.rotation.y = d.ry;
    m.visible = false;
    scene.add(m);
    _boundaryWalls.push(m);
  }
}

// ─── Roads ────────────────────────────────────────────────────────────────────
// Terrain-following quad-strip roads.  Rebuilt on each game start with a new seed.
const ROAD_WIDTH   = 7;
const _roadMat     = new THREE.MeshLambertMaterial({ color: CONFIG.COLOURS.road, side: THREE.DoubleSide });
const _roadSplines = [];   // [ [THREE.Vector3, ...], ... ]  — one array per road
const _roadMeshes  = [];   // tracked so they can be removed on rebuild

// Generate seeded road waypoints spanning the map in 3 directions.
// Waypoints are constructed so each intermediate point is strictly ordered
// along the primary axis — this prevents the CatmullRom curve from doubling back.
function _genRoadPaths(seed) {
  let s = (seed ^ 0xA5B6C7D8) >>> 0;
  const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
  const M   = CONFIG.MAP_HALF - 30;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Road 1: E-W — x increases monotonically, z wanders ±30 around a base z
  const z1 = (rng() - 0.5) * M * 0.8;
  const xSteps1 = [-M, -M*0.55, -M*0.15, M*0.15, M*0.55, M];
  const ew = xSteps1.map((x, i) => [x, clamp(z1 + (i > 0 && i < xSteps1.length-1 ? (rng()-0.5)*40 : (rng()-0.5)*15), -M, M)]);

  // Road 2: N-S — z increases monotonically, x wanders ±30 around a base x
  const x2 = (rng() - 0.5) * M * 0.8;
  const zSteps2 = [-M, -M*0.55, -M*0.15, M*0.15, M*0.55, M];
  const ns = zSteps2.map((z, i) => [clamp(x2 + (i > 0 && i < zSteps2.length-1 ? (rng()-0.5)*40 : (rng()-0.5)*15), -M, M), z]);

  // Road 3: diagonal — lerp from a south point to a north point, with small
  // perpendicular offsets (never backward along the primary z axis).
  const diagStartX = (rng() - 0.5) * M * 0.6;
  const diagEndX   = clamp(diagStartX + (rng() * 0.6 + 0.1) * M * (rng() < 0.5 ? 1 : -1), -M, M);
  const diagPts    = 5;
  const diag = [];
  for (let i = 0; i < diagPts; i++) {
    const t  = i / (diagPts - 1);
    const bx = diagStartX + (diagEndX - diagStartX) * t;
    const bz = -M + t * M * 2;
    // Perpendicular wander (never along primary z axis, so no backward motion)
    const perp = (diagEndX - diagStartX === 0) ? 1 : -(bz - (-M)) / (M * 2 - 0);  // rough perp dir
    const wobble = (i > 0 && i < diagPts - 1) ? (rng()-0.5)*30 : 0;
    diag.push([clamp(bx + wobble, -M, M), bz]);
  }

  const roads = [ew, ns, diag];

  // Optional 4th road (55% chance): another roughly-horizontal spur in the +z half
  if (rng() < 0.55) {
    const z4    = M * 0.15 + rng() * M * 0.7;
    const xS4   = [-M*0.75, (rng()-0.5)*M*0.5, M*0.75];
    roads.push(xS4.map((x, i) => [clamp(x, -M, M), clamp(z4 + (i === 1 ? (rng()-0.5)*35 : (rng()-0.5)*15), -M, M)]));
  }
  return roads;
}

function _buildRoadMesh(path) {
  const pts3d = path.map(([x, z]) => new THREE.Vector3(x, getAltitude(x, z) + 0.2, z));
  const curve = new THREE.CatmullRomCurve3(pts3d);
  const N     = Math.max(24, Math.round(curve.getLength() / 3));
  const spline = curve.getSpacedPoints(N);

  const posArr = [], idxArr = [];
  let prevRX = 0, prevRZ = 1; // track last cross-section direction to prevent flips
  for (let i = 0; i <= N; i++) {
    const pt  = spline[i];
    const tan = curve.getTangent(i / N).normalize();
    let rx  =  tan.z, rz = -tan.x;
    // If the perpendicular suddenly flips (dot < 0 with previous), reverse it.
    // This prevents the road surface from inverting when the tangent changes sharply.
    if (prevRX * rx + prevRZ * rz < 0) { rx = -rx; rz = -rz; }
    prevRX = rx; prevRZ = rz;
    const hw  = ROAD_WIDTH / 2;
    const lx = pt.x - rx * hw, lz = pt.z - rz * hw;
    const rx2 = pt.x + rx * hw, rz2 = pt.z + rz * hw;
    posArr.push(lx,  getAltitude(lx,  lz)  + 0.35, lz,
                rx2, getAltitude(rx2, rz2) + 0.35, rz2);
    if (i < N) { const a = i * 2; idxArr.push(a, a+1, a+2, a+1, a+3, a+2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
  geo.setIndex(idxArr);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, _roadMat);
  scene.add(mesh);
  return { mesh, spline };
}

function _rebuildRoads(seed) {
  // Remove old road meshes
  for (const m of _roadMeshes) { scene.remove(m); m.geometry.dispose(); }
  _roadMeshes.length = 0;
  _roadSplines.length = 0;

  const paths = _genRoadPaths(seed);
  for (const path of paths) {
    const { mesh, spline } = _buildRoadMesh(path);
    _roadMeshes.push(mesh);
    _roadSplines.push(spline);
  }
}

// Returns true if world position (x, z) is within half road-width (+extra) of any road
function _isOnRoad(x, z, extra = 0) {
  const r = ROAD_WIDTH * 0.5 + extra;
  const threshold = r * r;
  for (const spline of _roadSplines) {
    for (const pt of spline) {
      const dx = x - pt.x, dz = z - pt.z;
      if (dx * dx + dz * dz < threshold) return true;
    }
  }
  return false;
}

// Initial road build with a fixed seed; re-seeded on each game start via _rebuildMap().
_rebuildRoads(0xC0FFEE42);
// Set filter and load initial chunks.
chunkManager.setRoadFilter(_isOnRoad);
chunkManager.update(0, 0);

// Collision damage cooldown: tracks last time each tank took building-collision damage
const _buildingDmgCooldown = new Map();  // tank → seconds until next building hit allowed

// ─── Houses ───────────────────────────────────────────────────────────────────
// Walls: MeshBasicMaterial so they are always pure white regardless of lighting.
// Roof: MeshLambertMaterial with flatShading so each slope face gets diffuse shading.
// Windows/door: MeshBasicMaterial flat colours — pop against the white walls.
const _wallMat  = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, side: THREE.DoubleSide });
const _roofMat  = new THREE.MeshLambertMaterial({ color: CONFIG.COLOURS.roof, flatShading: true, side: THREE.DoubleSide });
const _winMat   = new THREE.MeshBasicMaterial({ color: 0x22AACC, side: THREE.DoubleSide });
const _hDoorMat = new THREE.MeshBasicMaterial({ color: 0x882222, side: THREE.DoubleSide });

// Returns { group, w, d, h } with group pivot at ground level.
function createHouse(small = false) {
  const w     = small ? 3.0 : 4.5;
  const d     = small ? 2.5 : 3.5;
  const h     = small ? 2.0 : 2.5;
  const roofH = small ? 1.5 : 2.0;

  const group = new THREE.Group();

  // White wall box
  const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), _wallMat);
  walls.position.y = h / 2;
  group.add(walls);

  // Triangular prism roof — ridge runs along the Z axis (front to back)
  const rv = new Float32Array([
    // Gable ends (front and back)
    -w/2, h, -d/2,   w/2, h, -d/2,   0, h+roofH, -d/2,
    -w/2, h,  d/2,   w/2, h,  d/2,   0, h+roofH,  d/2,
    // Left slope
    -w/2, h, -d/2,   0, h+roofH, -d/2,  -w/2, h,  d/2,
     0, h+roofH, -d/2,  0, h+roofH,  d/2,  -w/2, h,  d/2,
    // Right slope
     w/2, h, -d/2,   0, h+roofH, -d/2,   w/2, h,  d/2,
     0, h+roofH, -d/2,  0, h+roofH,  d/2,   w/2, h,  d/2,
  ]);
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.BufferAttribute(rv, 3));
  roofGeo.computeVertexNormals();
  group.add(new THREE.Mesh(roofGeo, _roofMat));

  // Two teal windows on front face (local -Z).
  // PlaneGeometry normals point +Z by default, so rotate π around Y to face outward (-Z).
  const winGeo = new THREE.PlaneGeometry(0.6, 0.5);
  for (const xOff of [-w / 4, w / 4]) {
    const win = new THREE.Mesh(winGeo, _winMat);
    win.position.set(xOff, h * 0.60, -d / 2 - 0.05);
    win.rotation.y = Math.PI;
    group.add(win);
  }

  // Dark-red door centred on front face, bottom-aligned with ground
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.9), _hDoorMat);
  door.position.set(0, 0.45, -d / 2 - 0.05);
  door.rotation.y = Math.PI;
  group.add(door);

  return { group, w, d, h };
}

// Houses clustered alongside roads. Entry format: { x, y, z, h, radius, meshes[], alive }
const _buildings = [];

// Water grid — declared here so _rebuildBuildings can safely call _waterAt before _rebuildWater runs
const WATER_CELL  = 8;   // world units per grid cell (shared with water section below)
const _waterGrid  = new Map();  // `${cx},${cz}` → { river:bool, pond:bool }

function _rebuildBuildings(seed) {
  // Remove old buildings
  for (const b of _buildings) {
    for (const m of b.meshes) { scene.remove(m); m.traverse(o => { if (o.isMesh) o.geometry.dispose(); }); }
  }
  _buildings.length = 0;

  let v = (seed ^ 0xDEADBEEF) >>> 0;
  const rng = () => { v = (Math.imul(v, 1664525) + 1013904223) >>> 0; return v / 0x100000000; };

  for (const spline of _roadSplines) {
    for (let si = 0; si < spline.length - 1; si += 8) {
      if (rng() > 0.30) continue;

      const clusterSize = 2 + Math.floor(rng() * 3);
      const segA = spline[si];
      const segB = spline[Math.min(si + 8, spline.length - 1)];
      const tdx = segB.x - segA.x, tdz = segB.z - segA.z;
      const tlen = Math.sqrt(tdx * tdx + tdz * tdz) || 1;
      const nx =  tdz / tlen, nz = -tdx / tlen;

      for (let ci = 0; ci < clusterSize; ci++) {
        const t       = rng();
        const side    = rng() > 0.5 ? 1 : -1;
        const sideOff = (ROAD_WIDTH * 0.8 + rng() * ROAD_WIDTH * 1.8) * side;
        const hx = segA.x + tdx * t + nx * sideOff;
        const hz = segA.z + tdz * t + nz * sideOff;
        const gy = getAltitude(hx, hz);

        if (gy < CONFIG.SEA_LEVEL + 2) continue;
        if (_isOnRoad(hx, hz, 4)) continue;   // extra margin so building edges don't overlap road
        if (_waterAt(hx, hz).onPond) continue;

        // Minimum separation: no building centre within ~2× typical building size (~10 units)
        const minSep = 10;
        let tooClose = false;
        for (const existing of _buildings) {
          const edx = hx - existing.x, edz = hz - existing.z;
          if (edx * edx + edz * edz < minSep * minSep) { tooClose = true; break; }
        }
        if (tooClose) continue;

        const { group, w, d, h } = createHouse(rng() > 0.5);
        group.position.set(hx, gy, hz);
        const faceX = (segA.x + tdx * 0.5) - hx;
        const faceZ = (segA.z + tdz * 0.5) - hz;
        group.rotation.y = Math.atan2(-faceX, -faceZ);
        scene.add(group);
        _buildings.push({
          x: hx, y: gy, z: hz, w, d, h,
          rotY: group.rotation.y,
          radius: Math.max(w, d) / 2,
          meshes: [group], alive: true,
        });
      }
    }
  }
}
_rebuildBuildings(0xC0FFEE42);

function createDestroyedHouse(b) {
  const group = new THREE.Group();
  group.position.set(b.x, b.y, b.z);
  group.rotation.y = b.rotY;

  const w = b.w, d = b.d, fullH = b.h;

  // Four walls, each split into sections at varying heights to give a jagged broken edge
  const wallDefs = [
    { start: [-w/2, 0, -d/2], end: [w/2, 0, -d/2], maxH: fullH * (0.5 + Math.random() * 0.4) },  // back  — least damaged
    { start: [-w/2, 0,  d/2], end: [w/2, 0,  d/2], maxH: fullH * (0.15 + Math.random() * 0.3) }, // front — most damaged
    { start: [-w/2, 0, -d/2], end: [-w/2, 0, d/2], maxH: fullH * (0.3 + Math.random() * 0.4) },  // left
    { start: [ w/2, 0, -d/2], end: [ w/2, 0, d/2], maxH: fullH * (0.3 + Math.random() * 0.4) },  // right
  ];

  for (const wall of wallDefs) {
    const sections = 3 + Math.floor(Math.random() * 2);
    const [sx, sy, sz] = wall.start;
    const [ex, ey, ez] = wall.end;

    for (let s = 0; s < sections; s++) {
      const t0 = s / sections, t1 = (s + 1) / sections;
      const x0 = sx + (ex - sx) * t0, z0 = sz + (ez - sz) * t0;
      const x1 = sx + (ex - sx) * t1, z1 = sz + (ez - sz) * t1;
      const h0 = wall.maxH * (0.4 + Math.random() * 0.6);  // left-edge height of section
      const h1 = wall.maxH * (0.4 + Math.random() * 0.6);  // right-edge height — jagged top

      const positions = [
        x0, 0,  z0,   x1, 0,  z1,   x1, h1, z1,
        x0, 0,  z0,   x1, h1, z1,   x0, h0, z0,
      ];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.computeVertexNormals();

      const burn = 0.08 + Math.random() * 0.12;
      group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(burn + 0.02, burn, burn - 0.02),
        side: THREE.DoubleSide,
      })));
    }
  }

  // Rubble inside and slightly beyond the footprint
  const rubbleCount = 8 + Math.floor(Math.random() * 8);
  for (let i = 0; i < rubbleCount; i++) {
    const rx   = (Math.random() - 0.5) * w * 1.2;
    const rz   = (Math.random() - 0.5) * d * 1.2;
    const size = 0.1 + Math.random() * 0.25;
    const geo  = new THREE.BoxGeometry(size, size * 0.5, size);
    const mat  = new THREE.MeshBasicMaterial({ color: new THREE.Color(
      0.1 + Math.random() * 0.15,
      0.08 + Math.random() * 0.1,
      0.06 + Math.random() * 0.08,
    )});
    const rubble = new THREE.Mesh(geo, mat);
    rubble.position.set(rx, Math.random() * 0.15, rz);
    rubble.rotation.set(Math.random() * 0.5, Math.random() * Math.PI * 2, Math.random() * 0.5);
    group.add(rubble);
  }

  // Ground scorch mark beneath the ruin
  const scorchGeo = new THREE.CircleGeometry(Math.max(w, d) * 0.8, 8);
  const scorchMat = new THREE.MeshBasicMaterial({
    color: 0x2C2A18,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const scorch = new THREE.Mesh(scorchGeo, scorchMat);
  scorch.rotation.x = -Math.PI / 2;
  scorch.position.y = 0.05;
  group.add(scorch);

  return group;
}

function destroyBuilding(b) {
  b.alive = false;
  for (const m of b.meshes) {
    scene.remove(m);
    m.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
  }
  b.meshes.length = 0;

  const ruin = createDestroyedHouse(b);
  scene.add(ruin);
  b.meshes.push(ruin);
}

// ─── Water system (rivers + ponds) ────────────────────────────────────────────
// Rivers are terrain-following quad strips (like roads but wider, blue).
// Ponds placed at local terrain minima with organic crater-style edges.
// Water only placed on low ground (alt < SEA_LEVEL + 6); never intersects roads.
// Total water area capped at 10% of map area.

const POND_RADIUS   = 22;
const WATER_ALT_MAX = CONFIG.SEA_LEVEL + 1;   // ponds only in flat flooded valleys (ensures full gradient visible)
const _waterMeshes  = [];   // tracked for removal on rebuild
// (_waterGrid and WATER_CELL declared earlier, above _rebuildBuildings)

function _waterCellKey(x, z) {
  return `${Math.floor(x / WATER_CELL)},${Math.floor(z / WATER_CELL)}`;
}
function _markWaterCell(x, z, isPond) {
  const k = _waterCellKey(x, z);
  const e = _waterGrid.get(k) || { river: false, pond: false };
  if (isPond) e.pond = true; else e.river = true;
  _waterGrid.set(k, e);
}

// Returns { onPond }
function _waterAt(x, z) {
  const e = _waterGrid.get(_waterCellKey(x, z));
  if (!e) return { onPond: false };
  return { onPond: e.pond };
}
// Speed multiplier from water (pond/flooded: 0.4, but no penalty within one cell of shore)
function _waterSpeedMult(x, z) {
  // Roads always take priority — no water penalty on a road crossing
  if (_isOnRoad(x, z)) return 1.0;
  if (_waterAt(x, z).onPond) {
    // No penalty at the shore — if any adjacent grid cell is dry, we're at the edge
    const atShore = !_waterAt(x + WATER_CELL, z).onPond || !_waterAt(x - WATER_CELL, z).onPond ||
                    !_waterAt(x, z + WATER_CELL).onPond || !_waterAt(x, z - WATER_CELL).onPond;
    return atShore ? 1.0 : 0.40;
  }
  // Flooded terrain: altitude clamped to SEA_LEVEL (flat blue tile)
  if (getAltitude(x, z) <= CONFIG.SEA_LEVEL + 0.5) return 0.40;
  return 1.0;
}

// Sample terrain altitude on a coarse grid to find low waypoints for rivers
function _findLowPoint(x0, z0, x1, z1, seed) {
  let s = seed;
  const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
  let bestAlt = Infinity, bestX = (x0 + x1) / 2, bestZ = (z0 + z1) / 2;
  for (let t = 0; t <= 1; t += 0.05) {
    const tx = x0 + (x1 - x0) * t + (rng() - 0.5) * 80;
    const tz = z0 + (z1 - z0) * t + (rng() - 0.5) * 80;
    const alt = getAltitude(tx, tz);
    if (alt < bestAlt && alt < WATER_ALT_MAX && !_isOnRoad(tx, tz)) {
      bestAlt = alt; bestX = tx; bestZ = tz;
    }
  }
  return bestAlt < WATER_ALT_MAX ? { x: bestX, z: bestZ, alt: bestAlt } : null;
}


function _buildPondMesh(cx, cz, rng = Math.random.bind(Math)) {
  const alt = getAltitude(cx, cz);
  if (alt > WATER_ALT_MAX) return null;
  if (_isOnRoad(cx, cz, POND_RADIUS * 1.5)) return null;

  const segments = 24;
  const rings    = 4;
  // Flat water surface 1 unit above terrain minimum — large enough gap to win
  // the depth buffer reliably, terrain banks above this level naturally clip the
  // pond giving an organic shoreline without any special clipping code.
  const flatY = alt + 1.0;
  const positions = [], colors = [];

  // Organic edge: wide random per-spoke noise, then 3 blur passes to remove sharp teeth
  let rawNoise = [];
  for (let s = 0; s < segments; s++) rawNoise.push(0.40 + rng() * 1.20);
  for (let pass = 0; pass < 3; pass++) {
    rawNoise = rawNoise.map((v, i) => {
      const p = rawNoise[(i - 1 + segments) % segments];
      const n = rawNoise[(i + 1) % segments];
      return (p + v * 2 + n) / 4;
    });
  }
  rawNoise.push(rawNoise[0]);  // close the loop
  const edgeNoise = rawNoise;  // length = segments + 1

  // Colour gradient: medium blue at centre → light water-blue at outer edge.
  // Subtle, evenly-spaced blend — no dark values, just medium→light.
  const ringColors = [
    [0.12, 0.25, 0.50],   // centre — medium blue
    [0.15, 0.30, 0.58],   // inner-mid
    [0.17, 0.35, 0.65],   // outer-mid
    [0.20, 0.40, 0.73],   // outer edge — light water colour
  ];

  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a0 = (s       / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;

      const rInner = (r       / rings) * POND_RADIUS;
      const rOuter = ((r + 1) / rings) * POND_RADIUS;

      const n0 = edgeNoise[s];
      const n1 = edgeNoise[s + 1];

      // All vertices at the flat water level — no per-vertex terrain sampling
      const corners = [
        { x: cx + Math.cos(a0) * rInner * n0, y: flatY, z: cz + Math.sin(a0) * rInner * n0 },
        { x: cx + Math.cos(a0) * rOuter * n0, y: flatY, z: cz + Math.sin(a0) * rOuter * n0 },
        { x: cx + Math.cos(a1) * rOuter * n1, y: flatY, z: cz + Math.sin(a1) * rOuter * n1 },
        { x: cx + Math.cos(a1) * rInner * n1, y: flatY, z: cz + Math.sin(a1) * rInner * n1 },
      ];

      const [cr, cg, cb] = ringColors[r];
      const facenoise = 0.90 + rng() * 0.20;
      const col = new THREE.Color(cr * facenoise, cg * facenoise, cb * facenoise);

      for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) {
        for (const vi of [a, b, c]) {
          positions.push(corners[vi].x, corners[vi].y, corners[vi].z);
          colors.push(col.r, col.g, col.b);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors,    3));

  const mat = new THREE.MeshBasicMaterial({
    vertexColors:        true,
    transparent:         true,
    opacity:             0.95,
    side:                THREE.DoubleSide,
    depthWrite:          false,
    polygonOffset:       true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits:  -2,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  scene.add(mesh);

  // Register water cells matching the actual noisy pond boundary (not a fixed circle)
  const gridExt = POND_RADIUS * 1.4;
  for (let dz = -gridExt; dz <= gridExt; dz += WATER_CELL) {
    for (let dx = -gridExt; dx <= gridExt; dx += WATER_CELL) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 0.001) { _markWaterCell(cx, cz, true); continue; }
      const angle  = Math.atan2(dz, dx);
      const normA  = (angle / (Math.PI * 2) + 1) % 1;
      const sFloat = normA * segments;
      const s0     = Math.floor(sFloat) % segments;
      const sT     = sFloat - Math.floor(sFloat);
      const spokeR = POND_RADIUS * (edgeNoise[s0] * (1 - sT) + edgeNoise[s0 + 1] * sT);
      if (dist <= spokeR) _markWaterCell(cx + dx, cz + dz, true);
    }
  }

  return mesh;
}

function _rebuildWater(seed) {
  // Remove old water meshes
  for (const m of _waterMeshes) { scene.remove(m); m.geometry.dispose(); }
  _waterMeshes.length = 0;
  _waterGrid.clear();

  let s = (seed ^ 0x57A7EB3F) >>> 0;
  const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };

  const M = CONFIG.MAP_HALF - 40;
  const mapArea = (M * 2) * (M * 2);
  const maxWaterArea = mapArea * 0.10;
  let waterArea = 0;

  // Place 2–3 ponds at randomly sampled low points
  const pondCount = 2 + Math.floor(rng() * 2);
  const pondCentres = [];
  for (let i = 0; i < pondCount; i++) {
    if (waterArea + Math.PI * POND_RADIUS * POND_RADIUS > maxWaterArea) break;
    let bestAlt = Infinity, bx = 0, bz = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      const tx = (rng() - 0.5) * M * 1.6, tz = (rng() - 0.5) * M * 1.6;
      const alt = getAltitude(tx, tz);
      if (alt < bestAlt && alt < WATER_ALT_MAX && !_isOnRoad(tx, tz, POND_RADIUS * 1.5)) {
        const tooClose = pondCentres.some(p => {
          const dx = p.x - tx, dz = p.z - tz;
          return dx*dx + dz*dz < (POND_RADIUS * 3) * (POND_RADIUS * 3);
        });
        if (!tooClose) { bestAlt = alt; bx = tx; bz = tz; }
      }
    }
    if (bestAlt < WATER_ALT_MAX) {
      const mesh = _buildPondMesh(bx, bz, rng);
      if (mesh) { _waterMeshes.push(mesh); pondCentres.push({ x: bx, z: bz }); }
      waterArea += Math.PI * POND_RADIUS * POND_RADIUS;
    }
  }

  // Register naturally-flooded terrain cells (altitude <= SEA_LEVEL) so the minimap
  // shows blue wherever terrain is rendered blue, not just where pond meshes sit.
  for (let wz = -M; wz <= M; wz += WATER_CELL) {
    for (let wx = -M; wx <= M; wx += WATER_CELL) {
      if (getAltitude(wx + WATER_CELL * 0.5, wz + WATER_CELL * 0.5) <= CONFIG.SEA_LEVEL + 0.5) {
        _markWaterCell(wx + WATER_CELL * 0.5, wz + WATER_CELL * 0.5, true);
      }
    }
  }
}

// Initial water build — will be seeded properly on game start via _rebuildMap
_rebuildWater(0xC0FFEE42);

// ─── Track trail system ────────────────────────────────────────────────────────
// Each mark has its own material so opacity can be faded per-mark over 30 seconds.
// polygonOffset prevents z-fighting against the terrain mesh.
const _trackMarkGeo  = new THREE.PlaneGeometry(0.35, 0.5);
_trackMarkGeo.rotateX(-Math.PI / 2);   // lay flat
const TRACK_FADE_S   = 30;
const TRACK_OPACITY  = 0.60;

class TrackTrail {
  constructor() {
    this.marks   = [];   // [{mesh, createdAt}]
    this.distAcc = 0;
    this.lastX   = null;
    this.lastZ   = null;
  }

  update(x, z, heading) {
    if (this.lastX !== null) {
      const dx = x - this.lastX, dz = z - this.lastZ;
      this.distAcc += Math.sqrt(dx * dx + dz * dz);
    }
    this.lastX = x; this.lastZ = z;

    // Drop new marks every 0.45 wu of travel
    if (this.distAcc >= 0.45) {
      this.distAcc = 0;
      const gy = getAltitude(x, z) + 0.12;
      const ph = Math.cos(heading) * 0.85;
      const pp = Math.sin(heading) * 0.85;

      for (const side of [-1, 1]) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0x332211,
          transparent: true,
          opacity: TRACK_OPACITY,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        });
        const mark = new THREE.Mesh(_trackMarkGeo, mat);
        mark.position.set(x + ph * side, gy, z - pp * side);
        mark.rotation.y = heading;
        scene.add(mark);
        this.marks.push({ mesh: mark, createdAt: performance.now() });
      }
    }

    // Fade marks by age; snap Y to current terrain every frame to prevent clipping on slopes
    const now = performance.now();
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const { mesh, createdAt } = this.marks[i];
      const age = (now - createdAt) / 1000;
      if (age > TRACK_FADE_S) {
        scene.remove(mesh);
        mesh.material.dispose();
        this.marks.splice(i, 1);
      } else {
        mesh.position.y = getAltitude(mesh.position.x, mesh.position.z) + 0.12;
        mesh.material.opacity = TRACK_OPACITY * (1 - age / TRACK_FADE_S);
      }
    }
  }

  // On tank death: reset createdAt of the last ~5 tank-lengths of marks so they linger at full opacity.
  // `tankLen` is the approximate hull length in world units; 5 × tankLen gives dramatic skid marks.
  freezeLastForDrama(tankLen = 8) {
    const maxDist = tankLen * 5;
    const now = performance.now();
    let dist = 0;
    // Marks stored left/right interleaved; step back in pairs
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i];
      if (i >= 2) {
        const prev = this.marks[i - 2];
        const dx = m.mesh.position.x - prev.mesh.position.x;
        const dz = m.mesh.position.z - prev.mesh.position.z;
        dist += Math.sqrt(dx * dx + dz * dz);
      }
      m.createdAt = now;  // reset age → full TRACK_FADE_S from now
      if (dist > maxDist) break;
    }
  }

  dispose() {
    for (const { mesh } of this.marks) { scene.remove(mesh); mesh.material.dispose(); }
    this.marks.length = 0;
  }
}

const _tankTrails = new Map();
function _getTrail(tank) {
  if (!_tankTrails.has(tank)) _tankTrails.set(tank, new TrackTrail());
  return _tankTrails.get(tank);
}

// ─── Player tank roster (non-German, selectable at menu) ──────────────────────
const WINGMAN_ROSTER = ['m24', 't34', 'kv1s', 'sherman'];   // lighter Allied tanks for wingman
// Start on a random Allied tank
const _initSelIdx = Math.floor(Math.random() * FACTION_ROSTERS.american.length);
let _selIdx = _initSelIdx;

// ─── Player ───────────────────────────────────────────────────────────────────
const input  = new Input();
let player = new Tank(scene, FACTION_ROSTERS.american[_initSelIdx]);
player.reloadTime  = player.reloadTime * DIFFICULTY.reloadMult;
player.reloadTimer = player.reloadTime;   // start already loaded

// ─── Game mode state ──────────────────────────────────────────────────────────
let _gameMode  = MODES.ARCADE;
let _menuStep  = 0;   // 0 = tank select, 1 = mode select
let _modeSelIdx = 0;  // 0=Arcade, 1=Attrition, 2=Strategy
let _faction   = 'american';            // currently selected army
let PLAYER_TANKS = FACTION_ROSTERS[_faction]; // current faction's tank roster

// Flat all-faction list: American [0-3], Russian [4-7], German [8-11], Mercenary [12-15]
const ALL_TANKS = [
  ...FACTION_ROSTERS.american,
  ...FACTION_ROSTERS.russian,
  ...FACTION_ROSTERS.german,
  ...FACTION_ROSTERS.mercenary,
];

function _factionFromIdx(idx) {
  if (idx < 4)  return 'american';
  if (idx < 8)  return 'russian';
  if (idx < 12) return 'german';
  return 'mercenary';
}

// Maps internal faction key to display name. plural=true → "Allies"/"Soviets", false → "Allied"/"Soviet"/"Axis"
function _factionLabel(f, plural = false) {
  if (f === 'american') return plural ? 'Allies'  : 'Allied';
  if (f === 'russian')  return plural ? 'Soviets' : 'Soviet';
  if (f === 'mercenary') return 'Mercs';
  return 'Axis';  // german — same in both forms
}
const MODE_LIST = [MODES.ARCADE, MODES.ATTRITION, MODES.STRATEGY, 'LAN'];

// Arcade state
let _arcadeClass     = 0;  // 0=light, 1=medium, 2=medium-heavy, 3=heavy
let _arcadeKills     = 0;  // kills at current class level
let _arcadeHeavyWave = 0;  // extra waves at class 3 (adds +2 enemies each)
let _upgradeAvailable = false;  // true when player has earned a tank upgrade but hasn't taken it

// Attrition state — squad persists across battles
let _attritionBattle = 0;
let _playerSquad     = [];  // all allied Tank instances
let _controlledIdx   = 0;   // which squad tank player controls
let _prevSquadAlive  = [];  // for squad death tracking

// Strategy state
let _strategyLevel   = 0;
let _strategyBudget  = STRATEGY_BUDGETS[0];
let _purchaseSquad   = {};  // { tankKey: count }
let _purchaseSelIdx  = 0;   // cursor in purchase screen

// Objective (Strategy)
let _objectivePos       = null;  // { x, z }
let _objectiveHold      = 0;     // seconds currently held
let _objectiveMesh      = null;
let _objectiveLabel     = null;
let _objectiveBeacon    = null;  // vertical beacon line
let _objectiveOuterRing = null;  // pulsing outer ring
let _objectivePhase     = 0;     // animation time accumulator

// ─── Wave definitions ─────────────────────────────────────────────────────────
// Three escalating waves of German armour matching the original game's progression.
const WAVE_DEFS = [
  // Wave 1 — light/medium introduction (8 enemies)
  [ { type:'pz3',      x:  120, z:   60 },
    { type:'pz3',      x: -100, z:   80 },
    { type:'panther',  x:   60, z: -110 },
    { type:'tiger',    x:  180, z:  -80 },
    { type:'pz3',      x:  -60, z:  -90 },
    { type:'pz3',      x:  100, z: -150 },
    { type:'panther',  x: -170, z:  100 },
    { type:'tiger',    x: -150, z: -130 } ],
  // Wave 2 — heavy assault (8 enemies)
  [ { type:'panther',  x: -130, z:  -70 },
    { type:'tiger',    x:   90, z:  120 },
    { type:'tiger',    x:  -70, z: -130 },
    { type:'kingtiger', x:  160, z:   90 },
    { type:'panther',  x:  130, z: -100 },
    { type:'tiger',    x: -120, z:   60 },
    { type:'kingtiger', x: -180, z:  -80 },
    { type:'panther',  x:   60, z:  150 } ],
  // Wave 3 — King Tiger onslaught (8 enemies)
  [ { type:'panther',  x: -140, z:  -50 },
    { type:'tiger',    x:   70, z: -140 },
    { type:'kingtiger', x:  150, z:   80 },
    { type:'kingtiger', x:  -90, z:  160 },
    { type:'tiger',    x:  -60, z:  130 },
    { type:'kingtiger', x:  180, z: -120 },
    { type:'kingtiger', x: -170, z:   50 },
    { type:'panther',  x:  120, z:  140 } ],
];

// ─── Mutable enemy arrays (replaced each wave) ────────────────────────────────
let enemies       = [];
let aiControllers = [];
let allTanks      = [player];
let prevAlive     = [];

// ─── Allied wingmen (7 AI teammates + player = 8v8) ──────────────────────────
let wingmen    = [];   // Tank instances
let wingmanAIs = [];   // WingmanController instances

// Staggered spawn positions around the player's start area
const WINGMAN_SPAWNS = [
  [  18,  12 ], [ -18,  10 ], [  22, -14 ],
  [ -12,  22 ], [  28,   6 ], [  -6, -20 ],
  [  16, -24 ],
];

function spawnWingmen() {
  for (const w of wingmen) w.dispose(scene);
  wingmen    = [];
  wingmanAIs = [];
  for (const [wx, wz] of WINGMAN_SPAWNS) {
    const type = WINGMAN_ROSTER[Math.floor(Math.random() * WINGMAN_ROSTER.length)];
    const w    = new Tank(scene, type, false);
    w.position.set(wx, getAltitude(wx, wz), wz);
    w.mesh.position.copy(w.position);
    w.heading = -0.5 + (Math.random() - 0.5) * 0.4;
    wingmen.push(w);
    wingmanAIs.push(new WingmanController(w));
  }
  if (hudHitIndicator) {
    hudHitIndicator.textContent = `◈  ${wingmen.length} FRIENDLY TANKS ATTACHED TO YOUR UNIT`;
    hudHitIndicator.style.color = 'rgba(80, 200, 255, 0.95)';
    hudHitIndicator.style.opacity = '1';
    _hitIndTimer = 3.5;
  }
}

function spawnWave(waveIdx) {
  // Remove previous wave tanks from scene
  for (const e of enemies) e.dispose(scene);
  enemies       = [];
  aiControllers = [];
  prevAlive     = [];

  for (const { type, x, z } of WAVE_DEFS[waveIdx]) {
    const t = new Tank(scene, type, true);
    t.position.set(x, getAltitude(x, z), z);
    t.mesh.position.copy(t.position);
    enemies.push(t);
    aiControllers.push(new AIController(t, x, z));
    prevAlive.push(true);
  }
  spawnWingmen();
  allTanks = [player, ...wingmen, ...enemies];
}

// ─── Faction helpers ──────────────────────────────────────────────────────────
function _selectedFaction() { return _faction; }

function _setFaction(f) {
  _faction     = f;
  PLAYER_TANKS = FACTION_ROSTERS[f];
  const base   = f === 'american' ? 0 : f === 'russian' ? 4 : f === 'german' ? 8 : 12; // mercenary = 12
  _selIdx      = base;
  _buildPreview(ALL_TANKS[_selIdx]);
  updateOverlay();
}

// ─── Spawn helpers for enemy tanks from a list of type keys ───────────────────
function _spawnEnemyList(typeList, colorOverride = null) {
  for (const e of enemies) e.dispose(scene);
  enemies = []; aiControllers = []; prevAlive = [];
  const count = typeList.length;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + 0.3;
    const dist  = 130 + Math.random() * 70;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const t = new Tank(scene, typeList[i], true, colorOverride);
    t.position.set(x, getAltitude(x, z), z);
    t.mesh.position.copy(t.position);
    enemies.push(t);
    aiControllers.push(new AIController(t, x, z));
    prevAlive.push(true);
  }
}

// ─── Arcade mode spawn ────────────────────────────────────────────────────────
function spawnArcadeWave() {
  clearBattleDebris();
  _resetEncounters();
  const cls   = ARCADE_CLASSES[_arcadeClass];
  const count = cls.count + (_arcadeClass === 3 ? _arcadeHeavyWave : 0);
  let types;
  if (_faction === 'german') {
    // Alternate Allied and Soviet tanks so Germany faces a combined force
    types = Array.from({ length: count }, (_, i) => cls.axisEnemies[i % 2]);
  } else {
    types = Array(count).fill(cls.allyEnemy);
  }
  _spawnEnemyList(types);
  // No wingmen in Arcade — solo player
  for (const w of wingmen) w.dispose(scene);
  wingmen = []; wingmanAIs = [];
  allTanks = [player, ...enemies];
  const { label: _wLabelA } = weather.init('arcade', 60 + enemies.length * 15);
  weather.markSkyDirty();
  if (hudEncounter) { hudEncounter.textContent = _wLabelA; hudEncounter.style.opacity = '1'; _encounterTimer = 4.0; }
}

// ─── Attrition mode spawn (uses persistent _playerSquad) ─────────────────────
function spawnAttritionBattle() {
  clearBattleDebris();
  _resetEncounters();
  const faction    = _selectedFaction();
  const squadDefs  = ATTRITION_PLAYER_SQUADS[faction];
  const enemySquad = faction === 'german' ? ATTRITION_ENEMY_SQUADS.allies : ATTRITION_ENEMY_SQUADS.german;
  const battleIdx  = Math.min(_attritionBattle, enemySquad.length - 1);
  const enemyTypes = enemySquad[battleIdx];

  // Build or reuse player squad tanks (first battle = spawn fresh)
  if (_playerSquad.length === 0) {
    for (const [i, type] of squadDefs.entries()) {
      const angle = (i / squadDefs.length) * Math.PI + Math.PI; // south side
      const dist  = 20 + i * 8;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      const t = new Tank(scene, type, false);
      t.position.set(x, getAltitude(x, z), z);
      t.mesh.position.copy(t.position);
      t.heading = 0;
      _playerSquad.push(t);
    }
    _controlledIdx = 0;
  } else {
    // Re-position surviving squad tanks for next battle
    const survivors = _playerSquad.filter(t => t.alive);
    for (const [i, t] of survivors.entries()) {
      const angle = (i / survivors.length) * Math.PI + Math.PI;
      const dist  = 20 + i * 8;
      t.position.set(Math.cos(angle) * dist, getAltitude(0, 0), Math.sin(angle) * dist);
      t.mesh.position.copy(t.position);
      t.leftSpeed = t.rightSpeed = 0;
    }
    // Re-index controlled to first alive tank
    _controlledIdx = _playerSquad.findIndex(t => t.alive);
  }
  _prevSquadAlive = _playerSquad.map(t => t.alive);

  // player = currently controlled squad tank
  player = _playerSquad[_controlledIdx];

  // All other alive squad tanks become wingmen
  wingmen    = [];
  wingmanAIs = [];
  for (const [i, t] of _playerSquad.entries()) {
    if (i === _controlledIdx || !t.alive) continue;
    wingmen.push(t);
    wingmanAIs.push(new WingmanController(t));
  }

  _spawnEnemyList(enemyTypes);
  allTanks = [..._playerSquad, ...enemies];
  const { label: _wLabelAt } = weather.init('attrition', 120);
  weather.markSkyDirty();
  if (hudEncounter) { hudEncounter.textContent = _wLabelAt; hudEncounter.style.opacity = '1'; _encounterTimer = 4.0; }
  _showSquadHUD();
}

// ─── Strategy mode spawn (uses _purchaseSquad) ────────────────────────────────
function spawnStrategyBattle() {
  clearBattleDebris();
  _resetEncounters();
  // First call: dispose the phantom Sherman (not yet in _playerSquad)
  if (_playerSquad.length === 0) player.dispose(scene);
  // Build player squad from purchase choices
  for (const t of _playerSquad) t.dispose(scene);
  _playerSquad = [];
  _controlledIdx = 0;

  // Determine team colours — player gets their faction's base colour; enemy gets a contrasting colour.
  // Valid pairs: green/yellow, yellow/green. Blue (mercenary) reserved for LAN.
  const _strategyPlayerColor = _faction === 'german'   ? 0xD4B822   // dunkelgelb yellow
                             : _faction === 'russian'  ? 0x3D9416   // forest green
                             :                           0x77DD22;  // lime green (american)
  const _strategyEnemyColor  = _faction === 'german'   ? 0x77DD22   // lime green vs yellow
                             :                           0xD4B822;  // yellow vs green

  const entries = Object.entries(_purchaseSquad).filter(([, n]) => n > 0);
  let idx = 0;
  for (const [type, count] of entries) {
    for (let c = 0; c < count; c++) {
      const angle = (idx / Math.max(1, _purchaseTotal())) * Math.PI + Math.PI;
      const dist  = 20 + idx * 8;
      const x = Math.cos(angle) * dist, z = Math.sin(angle) * dist;
      const t = new Tank(scene, type, false, _strategyPlayerColor);
      t.position.set(x, getAltitude(x, z), z);
      t.mesh.position.copy(t.position);
      _playerSquad.push(t);
      idx++;
    }
  }
  if (_playerSquad.length === 0) return; // shouldn't happen

  _prevSquadAlive = _playerSquad.map(() => true);
  player = _playerSquad[0];

  // AI enemy squad: fill budget with best tanks it can afford
  const enemyBudget = _strategyBudget;
  const enemyTypes  = _aiPurchase(enemyBudget);
  _spawnEnemyList(enemyTypes, _strategyEnemyColor);

  // Remaining squad tanks as wingmen
  wingmen    = [];
  wingmanAIs = [];
  for (let i = 1; i < _playerSquad.length; i++) {
    wingmen.push(_playerSquad[i]);
    wingmanAIs.push(new WingmanController(_playerSquad[i]));
  }

  allTanks = [..._playerSquad, ...enemies];
  _spawnCrates();
  _buildObjective();
  const { label: _wLabelSt } = weather.init('strategy', 180);
  weather.markSkyDirty();
  if (hudEncounter) { hudEncounter.textContent = _wLabelSt; hudEncounter.style.opacity = '1'; _encounterTimer = 4.0; }
  _showSquadHUD();
}

// AI "purchases" tanks for budget, heaviest first
// Buys the opposing faction's tanks (German player faces Allied AI; Allied/Russian player faces German AI)
function _aiPurchase(budget) {
  const aiTanks = _faction === 'german'
    ? [
        { key: 'js2',      cost: 480 },
        { key: 'pershing', cost: 400 },
        { key: 'kv85',     cost: 220 },
        { key: 'sherman',  cost: 220 },
        { key: 'm36',      cost: 180 },
        { key: 'kv1s',     cost: 160 },
        { key: 't34',      cost: 120 },
        { key: 'm24',      cost:  80 },
      ]
    : [
        { key: 'kingtiger', cost: 520 },
        { key: 'tiger',     cost: 360 },
        { key: 'panther',   cost: 240 },
        { key: 'pz3',       cost:  80 },
      ];
  const types = [];
  let remaining = budget;
  while (remaining > 80 && types.length < 10) {
    const affordable = aiTanks.filter(t => t.cost <= remaining);
    if (affordable.length === 0) break;
    const pick = affordable[0];  // buy the heaviest affordable
    types.push(pick.key);
    remaining -= pick.cost;
  }
  return types.length > 0 ? types : [aiTanks[aiTanks.length - 1].key];
}

function _purchaseTotal() {
  return Object.values(_purchaseSquad).reduce((s, n) => s + n, 0);
}

function _purchaseCost() {
  return Object.entries(_purchaseSquad)
    .reduce((s, [k, n]) => s + (TANK_COSTS[k] ?? 0) * n, 0);
}

// ─── Objective (Strategy) ─────────────────────────────────────────────────────
function _buildObjective() {
  // Dispose old meshes
  if (_objectiveMesh)      { scene.remove(_objectiveMesh);      _objectiveMesh.geometry.dispose(); }
  if (_objectiveBeacon)    { scene.remove(_objectiveBeacon);    _objectiveBeacon.geometry.dispose(); }
  if (_objectiveOuterRing) { scene.remove(_objectiveOuterRing); _objectiveOuterRing.geometry.dispose(); }

  const angle = Math.random() * Math.PI * 2;
  const dist  = 150 + Math.random() * 80;
  _objectivePos = { x: Math.cos(angle) * dist, z: Math.sin(angle) * dist };
  _objectiveHold  = 0;
  _objectivePhase = 0;

  const cx = _objectivePos.x, cz = _objectivePos.z;
  const y  = getAltitude(cx, cz) + 0.15;

  // Inner capture ring (always visible)
  const innerGeo = new THREE.RingGeometry(OBJECTIVE_RADIUS - 1.5, OBJECTIVE_RADIUS, 32);
  const innerMat = new THREE.MeshBasicMaterial({ color: 0xFFFF44, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  _objectiveMesh = new THREE.Mesh(innerGeo, innerMat);
  _objectiveMesh.rotation.x = -Math.PI / 2;
  _objectiveMesh.position.set(cx, y, cz);
  scene.add(_objectiveMesh);

  // Outer pulsing ring
  const outerGeo = new THREE.RingGeometry(OBJECTIVE_RADIUS + 2, OBJECTIVE_RADIUS + 5, 32);
  const outerMat = new THREE.MeshBasicMaterial({ color: 0xFFDD00, transparent: true, opacity: 0.50, depthWrite: false, side: THREE.DoubleSide });
  _objectiveOuterRing = new THREE.Mesh(outerGeo, outerMat);
  _objectiveOuterRing.rotation.x = -Math.PI / 2;
  _objectiveOuterRing.position.set(cx, y + 0.05, cz);
  scene.add(_objectiveOuterRing);

  // Transparent cylinder wall rising from the capture ring boundary, visible from a distance
  const beaconGeo = new THREE.CylinderGeometry(OBJECTIVE_RADIUS, OBJECTIVE_RADIUS, 55, 36, 1, true);
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xFFFF44, transparent: true, opacity: 0.15, depthWrite: false, side: THREE.DoubleSide });
  _objectiveBeacon = new THREE.Mesh(beaconGeo, beaconMat);
  _objectiveBeacon.position.set(cx, y + 27.5, cz);
  scene.add(_objectiveBeacon);
}

function _updateObjective(dt) {
  if (!_objectivePos || game.state !== STATES.PLAYING) return;
  const holdEl = document.getElementById('hud-objective');

  _objectivePhase += dt;
  // Outer ring pulses between 0.025 and 0.15 opacity at ~0.17 Hz (6x slower than original, 4x more transparent)
  const pulse = 0.0875 + 0.0625 * Math.sin(_objectivePhase * Math.PI * 2 / 6);
  if (_objectiveOuterRing) _objectiveOuterRing.material.opacity = pulse;
  // Beacon cylinder pulses gently
  if (_objectiveBeacon) _objectiveBeacon.material.opacity = 0.05 + 0.06 * Math.sin(_objectivePhase * Math.PI * 2 / 6);

  // Check if any squad tank is inside the objective
  const squadInside = _playerSquad.some(t => {
    if (!t.alive) return false;
    const dx = t.position.x - _objectivePos.x;
    const dz = t.position.z - _objectivePos.z;
    return Math.sqrt(dx * dx + dz * dz) < OBJECTIVE_RADIUS;
  });

  // Check if any enemy is contesting (within OBJECTIVE_CONTEST_R of objective)
  const contested = enemies.some(e => {
    if (!e.alive) return false;
    const dx = e.position.x - _objectivePos.x;
    const dz = e.position.z - _objectivePos.z;
    return Math.sqrt(dx * dx + dz * dz) < OBJECTIVE_CONTEST_R;
  });

  if (squadInside && !contested) {
    _objectiveHold += dt;
    // Inner ring brightens as capture progresses
    if (_objectiveMesh) {
      const t = Math.min(1, _objectiveHold / OBJECTIVE_HOLD_REQ);
      _objectiveMesh.material.color.setHex(0x44FF44);
      _objectiveMesh.material.opacity = 0.70 + t * 0.25;
    }
    if (_objectiveBeacon) _objectiveBeacon.material.color.setHex(0x44FF44);
    if (_objectiveOuterRing) _objectiveOuterRing.material.color.setHex(0x44FF44);
    if (holdEl) holdEl.textContent = `OBJ ${Math.ceil(OBJECTIVE_HOLD_REQ - _objectiveHold)}s`;
    if (_objectiveHold >= OBJECTIVE_HOLD_REQ) {
      // Objective captured — battle won!
      game.state = STATES.BATTLE_COMPLETE;
    }
  } else {
    if (squadInside && contested) {
      // Contested — flash red
      _objectiveHold = 0;
      if (_objectiveMesh) _objectiveMesh.material.color.setHex(0xFF4444);
      if (_objectiveBeacon) _objectiveBeacon.material.color.setHex(0xFF4444);
      if (_objectiveOuterRing) _objectiveOuterRing.material.color.setHex(0xFF4444);
      if (holdEl) holdEl.textContent = 'OBJ CONTESTED';
    } else {
      // Idle — yellow
      if (_objectiveMesh) {
        _objectiveMesh.material.color.setHex(0xFFFF44);
        _objectiveMesh.material.opacity = 0.85;
      }
      if (_objectiveBeacon) _objectiveBeacon.material.color.setHex(0xFFFF44);
      if (_objectiveOuterRing) _objectiveOuterRing.material.color.setHex(0xFFDD00);
      if (holdEl) holdEl.textContent = squadInside ? 'OBJ HOLD...' : '';
    }
  }
}

// ─── Tank switching (Attrition / Strategy) ────────────────────────────────────
function switchControlledTank(newIdx) {
  if (newIdx === _controlledIdx) return;
  if (!_playerSquad[newIdx] || !_playerSquad[newIdx].alive) return;

  const oldTank = player;

  // Hand old tank to AI
  if (!wingmen.includes(oldTank)) {
    wingmen.push(oldTank);
    wingmanAIs.push(new WingmanController(oldTank));
  }

  // Remove new tank from AI control
  const wi = wingmen.indexOf(_playerSquad[newIdx]);
  if (wi >= 0) { wingmen.splice(wi, 1); wingmanAIs.splice(wi, 1); }

  _controlledIdx = newIdx;
  player = _playerSquad[newIdx];
  player._camInit = false;
  _exitSightMode();

  if (hudName)    hudName.textContent    = player.def.name;
  if (hudFaction) hudFaction.textContent = _factionLabel(player.def.faction).toUpperCase();
  _showSquadHUD();
  // Flash the new tank's name below the squad icons
  if (hudTankNameFlash) {
    hudTankNameFlash.textContent = player.def.name;
    hudTankNameFlash.style.opacity = '1';
    _tankNameFlashTimer = 3.5;
  }
}

function _nextAliveTank() {
  const n = _playerSquad.length;
  for (let i = 1; i <= n; i++) {
    const idx = (_controlledIdx + i) % n;
    if (_playerSquad[idx].alive) return idx;
  }
  return -1;
}

// ─── Squad HUD helper ─────────────────────────────────────────────────────────
function _showSquadHUD() {
  const el = document.getElementById('hud-squad');
  if (!el) return;
  if (_gameMode === MODES.ARCADE) { el.textContent = ''; return; }
  const parts = _playerSquad.map((t, i) => {
    const mark = i === _controlledIdx ? '▶' : (t.alive ? '◈' : '✖');
    const col  = i === _controlledIdx ? 'rgba(100,220,255,0.9)'
               : t.alive              ? 'rgba(160,220,130,0.7)'
               :                       'rgba(180,80,60,0.6)';
    return `<span style="color:${col}">${mark}</span>`;
  });
  el.innerHTML = parts.join(' ');
}

// ─── Map rebuild (randomises terrain offset, roads, buildings, trees) ────────
function _rebuildMap() {
  const seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  // Shift the Fourier terrain sample point so hills/valleys vary each game
  setTerrainOffset((seed & 0xFFF) - 2048, ((seed >> 12) & 0xFFF) - 2048);
  // Rebuild roads first (buildings + water need them for exclusion zones)
  _rebuildRoads(seed);
  // Rebuild water — ponds placed at low terrain, avoid roads
  _rebuildWater(seed ^ 0x12345678);
  if (!_waterEnabled) for (const m of _waterMeshes) m.visible = false;
  // Update road filter now roads have changed (also filters trees)
  chunkManager.setRoadFilter((x, z) => _isOnRoad(x, z) || _waterAt(x, z).onPond);
  // Rebuild buildings alongside new roads (won't place on water/road)
  _rebuildBuildings(seed);
  // Flush cached chunk meshes so terrain + trees regenerate with new offset
  chunkManager.dispose();
  chunkManager.update(player.position.x, player.position.z);
}

function _applyStrategyConsumablesHud() {
  const s = _gameMode === MODES.STRATEGY;
  if (hudSmoke)   hudSmoke.style.display   = s ? '' : 'none';
  if (hudArty)    hudArty.style.display    = s ? '' : 'none';
  if (hudSpotter) hudSpotter.style.display = s ? '' : 'none';
}

// ─── Mode-specific game start functions ───────────────────────────────────────
function startArcade() {
  _rebuildMap();
  _gameMode       = MODES.ARCADE;
  _arcadeClass    = _selIdx % 4;  // start at the class matching the chosen tank (0-3 within faction)
  _arcadeKills    = 0;
  _arcadeHeavyWave = 0;
  const faction = _selectedFaction();
  const startType = ARCADE_CLASSES[_arcadeClass][faction];
  reinitPlayer(startType);
  clearCraters(); _resetSmoke(); _resetArtillery(); _resetSpotter();
  _lives = 2; _pendingRespawn = false;
  if (hudLives) hudLives.textContent = '';
  _drawLivesIcons();
  if (hudAmmo)  hudAmmo.style.display  = '';
  const squadEl = document.getElementById('hud-squad');
  if (squadEl) squadEl.textContent = '';
  game.start();
  game.totalWaves = 999; // arcade is endless
  spawnArcadeWave();
  if (hudPhase) hudPhase.textContent = 'ARCADE MODE';
  if (hudMode)  hudMode.textContent  = 'ARCADE MODE';
  _updateControlsHint();
  _applyStrategyConsumablesHud();
  _demoActive = _demoEnabled;
  _demoAI     = _demoActive ? new AIController(player, player.position.x, player.position.z) : null;
}

function startAttrition() {
  _rebuildMap();
  _gameMode        = MODES.ATTRITION;
  _attritionBattle = 0;
  // Dispose the phantom Sherman (initial player or previous game's player)
  if (_playerSquad.length === 0) player.dispose(scene);
  _playerSquad     = [];
  _controlledIdx   = 0;
  clearCraters(); _resetSmoke(); _resetArtillery(); _resetSpotter();
  _lives = 0; // no extra lives — squad IS your lives
  if (hudLives) hudLives.textContent = '';
  if (hudAmmo)  hudAmmo.style.display  = 'none';
  game.start();
  game.totalWaves = 999;
  spawnAttritionBattle();
  if (hudPhase) hudPhase.textContent = 'ATTRITION MODE';
  if (hudMode)  hudMode.textContent  = 'ATTRITION MODE';
  _updateControlsHint();
  _applyStrategyConsumablesHud();
  _demoActive = _demoEnabled;
  _demoAI     = _demoActive ? new AIController(player, player.position.x, player.position.z) : null;
}

function startStrategyPurchase() {
  _rebuildMap();
  _gameMode        = MODES.STRATEGY;
  _strategyLevel   = 0;
  _strategyBudget  = STRATEGY_BUDGETS[0];
  _playerSquad     = [];
  _purchaseSquad   = {};
  _purchaseSelIdx  = 0;
  for (const k of _strategyRoster()) _purchaseSquad[k] = 0;
  game.state = STATES.PURCHASE;
  updateOverlay();
}

function startStrategyBattle() {
  clearCraters(); _resetSmoke(); _resetArtillery(); _resetSpotter();
  _lives = 0;
  if (hudLives) hudLives.textContent = '';
  if (hudAmmo)  hudAmmo.style.display  = 'none';
  game.startFresh();
  game.totalWaves = 999;
  spawnStrategyBattle();
  if (hudPhase) hudPhase.textContent = 'STRATEGY MODE';
  if (hudMode)  hudMode.textContent  = 'STRATEGY MODE';
  _updateControlsHint();
  _applyStrategyConsumablesHud();
  _demoActive = _demoEnabled;
  _demoAI     = _demoActive ? new AIController(player, player.position.x, player.position.z) : null;
}

// ─── LAN duel functions ────────────────────────────────────────────────────────

function _cleanupLan() {
  _clearGhostShells();
  if (_lanSelfNametagEl && _lanSelfNametagEl.parentNode) { _lanSelfNametagEl.parentNode.removeChild(_lanSelfNametagEl); _lanSelfNametagEl = null; }
  // Dispose all peer tanks and remove nametag elements
  for (const [, peer] of _lanPeers) {
    if (peer.tank) peer.tank.dispose(scene);
    if (peer.nametagEl && peer.nametagEl.parentNode) peer.nametagEl.parentNode.removeChild(peer.nametagEl);
  }
  _lanPeers.clear();
  _lanRoster.clear();
  _ctf.dispose();
  _ctfMode = false;
  if (_lanNet)  { _lanNet.disconnect(); _lanNet = null; }
  _lanMode       = false;
  _lanGameActive = false;
  _lanStarted    = false;
  _lanStatus     = '';
  _lanEvents     = [];
  _lanGameResult = null;
  _lanEndTimer   = -1;
  _lanRtt        = 0;
  _lanLastSnapTs = 0;
  _lanRoomCode   = '';
}

// Relay server URL.
// HTTP (LAN): connect directly to port 8765 — no proxy config needed.
// HTTPS (internet): must use wss:// through the /relay NPM proxy (see FAQ).
const _relayUrl = location.protocol === 'https:'
  ? `wss://${location.host}/relay`
  : `ws://${location.hostname}:8765`;

// Discovery endpoint — same split: direct on HTTP, proxy path on HTTPS.
const _discoverUrl = location.protocol === 'https:'
  ? `https://${location.host}/relay/discover`
  : `http://${location.hostname}:8765/discover`;

async function startLanHost() {
  _lanTankKey    = ALL_TANKS[_selIdx];
  _lanPlayerName = (overlayControls.querySelector('#lan-name-input')?.value.trim() || '').slice(0, 16);
  _lanMyTeam     = parseInt(overlayControls.querySelector('#lan-team-sel')?.value ?? '0') || 0;
  _lanMaxPlayers = parseInt(overlayControls.querySelector('#lan-max-players')?.value ?? '2') || 2;
  _ctfMode       = overlayControls.querySelector('#lan-game-type')?.value === 'ctf';
  _lanRoomCode   = _genRoomCode();
  _lanMode       = true;
  _lanStarted    = false;
  _lanRoster.clear();
  _lanRoster.set('h', { name: _lanPlayerName, team: _lanMyTeam, tankKey: _lanTankKey });
  _lanStatus     = `Room ${_lanRoomCode} · Waiting for players…`;
  updateOverlay();

  _lanNet = new Net();
  _lanNet.onJoined     = () => { /* host doesn't need a hello — roster already seeded above */ };
  _lanNet.onPeerJoined = id => {
    // Add placeholder to roster; full info arrives via hello
    if (!_lanRoster.has(id)) _lanRoster.set(id, { name: id, team: 0, tankKey: 'sherman' });
    updateOverlay();
  };
  _lanNet.onPeerLeft  = id => {
    if (_lanGameActive) {
      // Remove their tank mid-game
      const peer = _lanPeers.get(id);
      if (peer) {
        if (peer.tank) peer.tank.dispose(scene);
        if (peer.nametagEl && peer.nametagEl.parentNode) peer.nametagEl.parentNode.removeChild(peer.nametagEl);
        _lanPeers.delete(id);
      }
      allTanks = [player, ...[..._lanPeers.values()].map(p => p.tank).filter(Boolean)];
    }
    _lanRoster.delete(id);
    updateOverlay();
  };
  _lanNet.onHostGone  = () => { _endLanSession('Connection lost.'); };
  _lanNet.onServerError = msg => { _lanStatus = `Error: ${msg}`; updateOverlay(); };
  _lanNet.onGameMessage = (from, msg) => {
    if (msg.t === 'h') {
      // Hello from a client — update roster and rebroadcast so all clients see the name
      _lanRoster.set(from, { name: (msg.n || from).slice(0, 16), team: msg.tm ?? 0, tankKey: msg.k || 'sherman' });
      if (_lanGameActive) {
        const peer = _lanPeers.get(from);
        if (peer) { peer.name = _lanRoster.get(from).name; peer.team = _lanRoster.get(from).team; }
      }
      if (!_lanGameActive) _lanNet.sendRoster(_lanRoster);
      updateOverlay();
    }
  };

  try {
    await _lanNet.host(_relayUrl, _lanRoomCode, _lanMaxPlayers);
    // Immediately send our own hello back to ourselves? No — host just waits.
  } catch (e) {
    _lanStatus = `Cannot reach relay server (${e.message})`;
    updateOverlay();
  }
}

function startLanGameAsHost() {
  if (!_lanNet || !_lanNet.isHost() || _lanRoster.size < 2 || _lanStarted) return;
  _lanStarted = true;
  // Send start message with full roster to all clients, then init locally
  _lanNet.sendStart(_lanRoster, _ctfMode ? 'ctf' : '');
  _initLanGame(_lanRoster);
}

async function startLanClient(roomCode) {
  _lanTankKey    = ALL_TANKS[_selIdx];
  _lanPlayerName = (overlayControls.querySelector('#lan-name-input')?.value.trim() || '').slice(0, 16);
  _lanMyTeam     = parseInt(overlayControls.querySelector('#lan-team-sel')?.value ?? '0') || 0;
  _lanRoomCode   = roomCode.toUpperCase().trim();
  _lanMode       = true;
  _lanStarted    = false;
  _lanRoster.clear();
  _lanStatus     = `Joining room ${_lanRoomCode}…`;
  updateOverlay();

  _lanNet = new Net();
  _lanNet.onJoined = (id, role, peers) => {
    // Auto-assign a unique team based on join order (host=0, first joiner=1, etc.)
    _lanMyTeam = Math.min(peers.length, LAN_TEAM_COLORS.length - 1);
    // We're in — send our hello to the host
    _lanNet.sendHello(_lanTankKey, _lanPlayerName, _lanMyTeam);
    // Add own entry so roster size matches the host's view
    _lanRoster.set(id, { name: _lanPlayerName, team: _lanMyTeam, tankKey: _lanTankKey });
    // Populate roster placeholders for existing peers
    for (const peerId of peers) {
      if (!_lanRoster.has(peerId)) _lanRoster.set(peerId, { name: peerId, team: 0, tankKey: 'sherman' });
    }
    _lanStatus = `Room ${_lanRoomCode} · Waiting for host to start…`;
    updateOverlay();
  };
  _lanNet.onPeerJoined = id => {
    if (!_lanRoster.has(id)) _lanRoster.set(id, { name: id, team: 0, tankKey: 'sherman' });
    updateOverlay();
  };
  _lanNet.onPeerLeft = id => {
    if (_lanGameActive) {
      const peer = _lanPeers.get(id);
      if (peer) {
        if (peer.tank) peer.tank.dispose(scene);
        if (peer.nametagEl && peer.nametagEl.parentNode) peer.nametagEl.parentNode.removeChild(peer.nametagEl);
        _lanPeers.delete(id);
      }
      allTanks = [player, ...[..._lanPeers.values()].map(p => p.tank).filter(Boolean)];
    }
    _lanRoster.delete(id);
    updateOverlay();
  };
  _lanNet.onHostGone  = () => { _endLanSession('Host disconnected.'); };
  _lanNet.onServerError = msg => { _lanStatus = `Error: ${msg}`; updateOverlay(); };
  _lanNet.onGameMessage = (from, msg) => {
    if (msg.t === 'h') {
      // Hello from another player — update roster
      _lanRoster.set(from, { name: (msg.n || from).slice(0, 16), team: msg.tm ?? 0, tankKey: msg.k || 'sherman' });
      updateOverlay();
    } else if (msg.t === 'roster') {
      // Host rebroadcast: update all entries except own
      const myId = _lanNet.id;
      for (const [id, p] of Object.entries(msg.roster || {})) {
        if (id !== myId) _lanRoster.set(id, { name: (p.n || id).slice(0, 16), team: p.tm ?? 0, tankKey: p.k || 'sherman' });
      }
      updateOverlay();
    } else if (msg.t === 'start') {
      // Host triggered start — msg.roster has all players
      if (_lanStarted) return;
      _lanStarted = true;
      _ctfMode = (msg.mode === 'ctf');
      const rosterMap = new Map();
      for (const [id, p] of Object.entries(msg.roster || {})) {
        rosterMap.set(id, { name: (p.n || id).slice(0, 16), team: p.tm ?? 0, tankKey: p.k || 'sherman' });
      }
      // Ensure own entry is correct
      rosterMap.set(_lanNet.id, { name: _lanPlayerName, team: _lanMyTeam, tankKey: _lanTankKey });
      _lanRoster = rosterMap;
      _initLanGame(_lanRoster);
    }
  };

  try {
    await _lanNet.join(_relayUrl, _lanRoomCode);
  } catch (e) {
    _lanStatus = `Cannot reach relay server (${e.message})`;
    updateOverlay();
  }
}

function _initLanGame(rosterMap) {
  clearCraters(); _resetSmoke(); _resetArtillery(); _resetSpotter();
  _resetEncounters();
  for (const e of enemies) e.dispose(scene);
  enemies = []; aiControllers = [];
  for (const w of wingmen) w.dispose(scene);
  wingmen = []; wingmanAIs = [];

  // Dispose any previous peer tanks/nametags
  for (const [, peer] of _lanPeers) {
    if (peer.tank) peer.tank.dispose(scene);
    if (peer.nametagEl && peer.nametagEl.parentNode) peer.nametagEl.parentNode.removeChild(peer.nametagEl);
  }
  _lanPeers.clear();

  const myId    = _lanNet.id;
  const myEntry = rosterMap.get(myId);

  // Place player (local tank) — apply own team colour so model matches nametag
  const _myColor = LAN_TEAM_COLORS[myEntry?.team ?? _lanMyTeam ?? 0] ?? null;
  reinitPlayer(myEntry?.tankKey ?? _lanTankKey, _myColor);
  // Spawn positions: spread along X axis, facing center
  const playerIds = [...rosterMap.keys()];
  const myIdx     = playerIds.indexOf(myId);
  const total     = playerIds.length;
  const SPREAD    = 20;
  const spawnX    = (myIdx - (total - 1) / 2) * SPREAD;
  const spawnZ    = _lanNet.isHost() ? -40 : 40;
  player.position.set(spawnX, getAltitude(spawnX, spawnZ) + 0.1, spawnZ);
  player.heading = _lanNet.isHost() ? 0 : Math.PI;

  // Create own nametag
  if (_lanSelfNametagEl && _lanSelfNametagEl.parentNode) _lanSelfNametagEl.parentNode.removeChild(_lanSelfNametagEl);
  _lanSelfNametagEl = document.createElement('div');
  _lanSelfNametagEl.className = 'lan-nametag';
  _lanSelfNametagEl.style.display = 'none';
  document.getElementById('canvas-wrap').appendChild(_lanSelfNametagEl);

  // Place peer tanks
  for (const [id, entry] of rosterMap) {
    if (id === myId) continue;
    const idx   = playerIds.indexOf(id);
    const px    = (idx - (total - 1) / 2) * SPREAD;
    const pz    = _lanNet.isHost() ? 40 : -40;
    const isEnemy = true;
    const color = LAN_TEAM_COLORS[entry.team ?? 0] ?? null;
    const tank  = new Tank(scene, entry.tankKey ?? 'sherman', isEnemy, color);
    tank.position.set(px, getAltitude(px, pz) + 0.1, pz);
    tank.heading = _lanNet.isHost() ? Math.PI : 0;

    // Create nametag element
    const el = document.createElement('div');
    el.className = 'lan-nametag';
    el.style.display = 'none';
    document.getElementById('canvas-wrap').appendChild(el);

    _lanPeers.set(id, { tank, name: entry.name ?? id, team: entry.team ?? 0, tankKey: entry.tankKey ?? 'sherman', nametagEl: el });
  }

  allTanks = [player, ...[..._lanPeers.values()].map(p => p.tank)];
  combat.dispose();

  // Initialise CTF if this game mode was selected
  if (_ctfMode) {
    // Flag bases at opposite ends of map, centred on X=0
    _ctf.init([
      { x: 0, z: -80 },  // team 0 flag base (south)
      { x: 0, z:  80 },  // team 1 flag base (north)
    ]);
  }

  _lanGameActive  = true;
  _lanStarted     = true;
  _lanBroadTimer  = 0;
  _lanEvents      = [];
  _lanGameResult  = null;
  _lanEndTimer    = -1;
  _lanRtt         = 0;
  _lanLastSnapTs  = 0;
  _demoActive     = false;
  _demoAI         = null;

  weather.init('online', 300);
  weather.markSkyDirty();

  game.start();
  if (hudMode)  hudMode.textContent  = 'LAN';
  if (hudPhase) hudPhase.textContent = 'LAN';
  _updateControlsHint();
  updateOverlay();
}

function _endLanGame(won) {
  if (_lanGameResult !== null) return;  // guard against double-trigger
  _lanGameResult = won ? 'local' : 'peer';
  if (_lanNet && _lanNet.isHost()) {
    // Host: keep broadcasting res for 500 ms so clients receive it
    _lanEndTimer = 0.5;
  } else {
    // Client: result came from host snapshot — end immediately
    _lanGameActive = false;
    game.state = won ? STATES.VICTORY : STATES.GAME_OVER;
    updateOverlay();
  }
}

function _endLanSession(msg) {
  _lanGameActive = false;
  if (game.isPlaying) {
    game.state = STATES.GAME_OVER;
  }
  _lanStatus = msg;
  _cleanupLan();
  game.state = STATES.LAN_LOBBY;
  _lanMode   = true;  // keep lobby visible so user sees the message
  updateOverlay();
}

// Build N-player snapshot: { players: {id: state}, ev, res, rtt, ts }
function _buildLanSnapshot() {
  const players = { [_lanNet.id]: player.getState() };
  for (const [id, peer] of _lanPeers) players[id] = peer.tank ? peer.tank.getState() : null;
  return players;
}

// Build shell array for snapshot: [{px,py,pz,vx,vy,vz,c}] — host only
function _buildShellSnapshot() {
  return combat.shells.map(s => {
    let team = 0;
    if (s.firedBy === player) {
      team = _lanRoster.get(_lanNet.id)?.team ?? 0;
    } else {
      for (const [id, peer] of _lanPeers) {
        if (peer.tank === s.firedBy) { team = _lanRoster.get(id)?.team ?? 0; break; }
      }
    }
    return { px: s.px, py: s.py, pz: s.pz, vx: s.vx, vy: s.vy, vz: s.vz, c: LAN_TEAM_COLORS[team] ?? LAN_TEAM_COLORS[0] };
  });
}

// Apply/reconcile ghost shell pool from snapshot (client only)
function _applyGhostShells(shells) {
  while (_lanGhostShells.length < shells.length) {
    const mat  = new THREE.MeshBasicMaterial({ color: 0xFFFFFF });
    const mesh = new THREE.Mesh(_ghostShellGeo, mat);
    scene.add(mesh);
    _lanGhostShells.push({ mesh, vx: 0, vy: 0, vz: 0 });
  }
  for (let i = shells.length; i < _lanGhostShells.length; i++) {
    _lanGhostShells[i].mesh.visible = false;
  }
  for (let i = 0; i < shells.length; i++) {
    const sd = shells[i];
    const gs = _lanGhostShells[i];
    gs.vx = sd.vx;  gs.vy = sd.vy;  gs.vz = sd.vz;
    gs.mesh.material.color.setHex(sd.c);
    gs.mesh.position.set(sd.px, sd.py, sd.pz);
    _ghostShellVel.set(sd.vx, sd.vy, sd.vz).normalize();
    gs.mesh.quaternion.setFromUnitVectors(_ghostShellFwd, _ghostShellVel);
    gs.mesh.visible = true;
  }
}

function _clearGhostShells() {
  for (const gs of _lanGhostShells) {
    scene.remove(gs.mesh);
    gs.mesh.material.dispose();
  }
  _lanGhostShells = [];
}

// ── CTF helpers ───────────────────────────────────────────────────────────────

// Build [{id, name, team, tank}] for all players in the LAN game
function _buildCtfPlayerList() {
  const list = [{ id: _lanNet.id, name: _lanPlayerName, team: _lanMyTeam, tank: player }];
  for (const [id, peer] of _lanPeers) {
    list.push({ id, name: peer.name, team: peer.team, tank: peer.tank });
  }
  return list;
}

// Process a CTF event (same function used by host and client)
function _processCtfEvent(ev) {
  if (!ev) return;
  const scores = ev.scores ? `${FLAG_NAMES[0]} ${ev.scores[0]} — ${ev.scores[1]} ${FLAG_NAMES[1]}` : '';
  const myTeam = _lanRoster.get(_lanNet?.id)?.team ?? _lanMyTeam ?? 0;

  if (ev.type === 'pickup') {
    const isMine = ev.playerId === _lanNet?.id;
    const flagColor = `#${FLAG_COLORS[ev.flagTeam].toString(16).padStart(6,'0')}`;
    const msg = isMine
      ? `YOU PICKED UP THE ${FLAG_NAMES[ev.flagTeam]} FLAG!`
      : `${ev.playerName} picked up the ${FLAG_NAMES[ev.flagTeam]} flag`;
    _showCtfAnnouncement(msg, isMine ? 'rgba(255,230,80,0.95)' : 'rgba(180,180,180,0.85)');

  } else if (ev.type === 'capture') {
    const won = ev.scoringTeam === myTeam;
    _showCtfAnnouncement(
      `${FLAG_NAMES[ev.scoringTeam]} TEAM CAPTURED THE FLAG! ${scores}`,
      won ? 'rgba(80,255,120,0.95)' : 'rgba(255,80,80,0.95)',
    );

  } else if (ev.type === 'return') {
    _showCtfAnnouncement(`${FLAG_NAMES[ev.flagTeam]} flag returned to base`, 'rgba(180,220,255,0.85)');

  } else if (ev.type === 'gameover') {
    const won = ev.winner === myTeam;
    _showCtfAnnouncement(
      `${FLAG_NAMES[ev.winner]} TEAM WINS! Final: ${scores}`,
      won ? 'rgba(80,255,120,0.95)' : 'rgba(255,80,80,0.95)',
    );

  } else if (ev.type === 'respawn') {
    // Respawn the tank at their base
    const basePos = _ctf.getBasePos(ev.team);
    if (ev.id === _lanNet?.id) {
      // Own respawn
      player.alive = true;
      player.hp    = player.maxHp;
      player.position.set(basePos.x, basePos.y + 0.1, basePos.z);
      player.mesh.position.copy(player.position);
      player.mesh.visible = true;
      player.leftSpeed = player.rightSpeed = 0;
    } else {
      const peer = _lanPeers.get(ev.id);
      if (peer?.tank) {
        peer.tank.alive = true;
        peer.tank.hp    = peer.tank.maxHp;
        peer.tank.position.set(basePos.x, basePos.y + 0.1, basePos.z);
        peer.tank.mesh.position.copy(peer.tank.position);
        peer.tank.mesh.visible = true;
        peer.tank.leftSpeed = peer.tank.rightSpeed = 0;
      }
    }
  }
}

// Create CTF HUD elements once
const _ctfHud = (() => {
  const scoreEl = document.createElement('div');
  Object.assign(scoreEl.style, {
    position: 'absolute', top: '14px', left: '50%', transform: 'translateX(-50%)',
    font: 'bold 18px "Courier New",monospace', color: '#FFFFFF',
    textShadow: '0 0 6px rgba(0,0,0,0.9)', pointerEvents: 'none',
    display: 'none', textAlign: 'center', letterSpacing: '0.1em',
  });
  document.getElementById('hud').appendChild(scoreEl);

  const flagEl = document.createElement('div');
  Object.assign(flagEl.style, {
    position: 'absolute', top: '40px', left: '50%', transform: 'translateX(-50%)',
    font: '11px "Courier New",monospace', color: 'rgba(200,220,255,0.85)',
    textShadow: '0 0 4px rgba(0,0,0,0.8)', pointerEvents: 'none',
    display: 'none', textAlign: 'center', whiteSpace: 'nowrap',
  });
  document.getElementById('hud').appendChild(flagEl);

  const carrierEl = document.createElement('div');
  Object.assign(carrierEl.style, {
    position: 'absolute', top: '38%', left: '50%', transform: 'translateX(-50%)',
    font: 'bold 14px "Courier New",monospace', color: 'rgba(255,230,80,0.95)',
    textShadow: '0 0 6px rgba(0,0,0,0.9)', pointerEvents: 'none',
    display: 'none', textAlign: 'center',
  });
  document.getElementById('hud').appendChild(carrierEl);

  const respawnEl = document.createElement('div');
  Object.assign(respawnEl.style, {
    position: 'absolute', top: '45%', left: '50%', transform: 'translateX(-50%)',
    font: 'bold 22px "Courier New",monospace', color: 'rgba(255,100,100,0.95)',
    textShadow: '0 0 8px rgba(0,0,0,0.9)', pointerEvents: 'none',
    display: 'none', textAlign: 'center',
  });
  document.getElementById('hud').appendChild(respawnEl);

  const announceEl = document.createElement('div');
  Object.assign(announceEl.style, {
    position: 'absolute', top: '28%', left: '50%', transform: 'translateX(-50%)',
    font: 'bold 16px "Courier New",monospace', pointerEvents: 'none',
    display: 'none', textAlign: 'center', whiteSpace: 'nowrap',
    textShadow: '0 0 8px rgba(0,0,0,0.9)',
  });
  document.getElementById('hud').appendChild(announceEl);

  return { scoreEl, flagEl, carrierEl, respawnEl, announceEl };
})();
let _ctfAnnounceTimer = 0;

function _showCtfAnnouncement(msg, color = 'rgba(255,255,255,0.95)') {
  _ctfHud.announceEl.textContent = msg;
  _ctfHud.announceEl.style.color = color;
  _ctfHud.announceEl.style.display = '';
  _ctfAnnounceTimer = 5.0;
}

function _updateCtfHud() {
  if (!_ctfMode) {
    _ctfHud.scoreEl.style.display   = 'none';
    _ctfHud.flagEl.style.display    = 'none';
    _ctfHud.carrierEl.style.display = 'none';
    _ctfHud.respawnEl.style.display = 'none';
    _ctfHud.announceEl.style.display = 'none';
    return;
  }

  const myId   = _lanNet?.id;
  const myTeam = _lanRoster.get(myId)?.team ?? _lanMyTeam ?? 0;
  const scores = _ctf.getScores();

  // Score display
  const g = `#${FLAG_COLORS[0].toString(16).padStart(6,'0')}`;
  const b = `#${FLAG_COLORS[1].toString(16).padStart(6,'0')}`;
  _ctfHud.scoreEl.innerHTML =
    `<span style="color:${g}">${FLAG_NAMES[0]} ${scores[0]}</span>` +
    ` <span style="color:#aaa">—</span> ` +
    `<span style="color:${b}">${scores[1]} ${FLAG_NAMES[1]}</span>`;
  _ctfHud.scoreEl.style.display = '';

  // Flag status
  const flagLine = (t) => {
    const own = t === myTeam ? 'YOUR FLAG' : 'ENEMY FLAG';
    const st  = _ctf.getFlagStatus(t);
    const dt  = Math.ceil(_ctf.getDropTimer(t));
    if (st === 'base') return `${own}: At base`;
    if (st === 'carried') {
      const nm = _ctf.getFlagCarrierName(t);
      return `${own}: STOLEN by ${nm}`;
    }
    return `${own}: Dropped (${dt}s)`;
  };
  _ctfHud.flagEl.textContent = `${flagLine(0)}   ${flagLine(1)}`;
  _ctfHud.flagEl.style.display = '';

  // Carrier prompt
  if (player?.ctfCarrying) {
    _ctfHud.carrierEl.textContent = 'YOU HAVE THE FLAG — Return to base!  [NO FIRE]';
    _ctfHud.carrierEl.style.display = '';
  } else {
    _ctfHud.carrierEl.style.display = 'none';
  }

  // Respawn countdown
  const respawnT = _ctf.getRespawnTimer(myId);
  if (respawnT !== null && !player?.alive) {
    _ctfHud.respawnEl.textContent = `RESPAWNING IN ${Math.ceil(respawnT)}s`;
    _ctfHud.respawnEl.style.display = '';
  } else {
    _ctfHud.respawnEl.style.display = 'none';
  }

  // Announcement timer
  if (_ctfAnnounceTimer > 0) {
    _ctfAnnounceTimer -= (1 / 60);  // approximate; proper dt not available here
    if (_ctfAnnounceTimer <= 0) _ctfHud.announceEl.style.display = 'none';
  }
}

// LAN game loop — called from animate() when _lanMode && _lanGameActive
function _runLanFrame(dt, now) {
  if (_lanNet.isHost()) {
    // ── Host: drive own tank; apply each client's input to their tank ──────────
    if (player.alive) {
      player.update(dt, input);
      player.updateCamera(camera, dt);
      if (input.fire || input.fireOnce) {
        const tip = combat.fire(player, _ammoType);
        if (tip) {
          particles.muzzleFlash(tip.x, tip.y, tip.z);
          audio.playFire();
          _lanEvents.push({ t: 'fl', x: tip.x, y: tip.y, z: tip.z });
        }
      }
    }

    for (const [id, peer] of _lanPeers) {
      const ci = _lanNet.clientInputs.get(id);
      if (peer.tank && peer.tank.alive && ci) {
        peer.tank.update(dt, ci);
        if (ci.fire || ci.fireOnce) {
          const tip = combat.fire(peer.tank);
          if (tip) {
            particles.muzzleFlash(tip.x, tip.y, tip.z);
            _lanEvents.push({ t: 'fl', x: tip.x, y: tip.y, z: tip.z });
          }
        }
      }
    }

    // Combat: shells vs all tanks; collect events for broadcast
    const impacts = combat.update(dt, allTanks);
    for (const imp of impacts) {
      if (imp.penetrated) {
        particles.explosion(imp.x, imp.y, imp.z);
        _lanEvents.push({ t: 'ex', x: imp.x, y: imp.y, z: imp.z });
      } else {
        particles.ricochet(imp.x, imp.y, imp.z);
        _lanEvents.push({ t: 'rc', x: imp.x, y: imp.y, z: imp.z });
      }
      if (imp.tank && !imp.tank.alive) {
        imp.tank.setDestroyed();
        // CTF: queue respawn for the dead player
        if (_ctfMode) {
          let deadId = null, deadTeam = 0, deadKey = 'sherman';
          if (imp.tank === player) {
            deadId = _lanNet.id; deadTeam = _lanMyTeam; deadKey = _lanTankKey;
          } else {
            for (const [id, peer] of _lanPeers) {
              if (peer.tank === imp.tank) {
                deadId = id; deadTeam = peer.team; deadKey = peer.tankKey; break;
              }
            }
          }
          if (deadId) _ctf.queueRespawn(deadId, deadTeam, deadKey);
        }
      }
    }

    // CTF host update
    if (_ctfMode) {
      _ctf.update(dt, _buildCtfPlayerList());
      for (const ev of _ctf.getEvents()) {
        _lanEvents.push({ t: 'ctf', ev });
        _processCtfEvent(ev);
      }
      _ctf.clearEvents();

      // Handle respawn events: bring dead tanks back at their base
      // (respawn events were pushed to _lanEvents above during _ctf.update)
      // They are processed by _processCtfEvent which handles the 'respawn' case.

      // CTF win condition
      if (_lanGameResult === null && _ctf.getWinner() !== null) {
        const myTeam = _lanRoster.get(_lanNet.id)?.team ?? 0;
        _endLanGame(_ctf.getWinner() === myTeam);
      }
    }

    // Broadcast snapshot at LAN_SNAP_HZ
    _lanBroadTimer -= dt;
    if (_lanBroadTimer <= 0) {
      _lanBroadTimer = 1 / LAN_SNAP_HZ;
      // RTT measurement: use the most-recent echo ts from any client
      let latestEchoTs = 0;
      for (const ts of _lanNet.clientEchoTs.values()) if (ts > latestEchoTs) latestEchoTs = ts;
      if (latestEchoTs) {
        _lanRtt = Math.round(Date.now() - latestEchoTs);
        _lanNet.clientEchoTs.clear();
      }
      _lanNet.sendSnapshot({
        players: _buildLanSnapshot(),
        shells:  _buildShellSnapshot(),
        ev:  _lanEvents.splice(0),
        res: _lanGameResult,
        rtt: _lanRtt,
        ts:  Date.now(),
        ctf: _ctfMode ? _ctf.getState() : null,
      });
    }

    // End condition — deathmatch (not CTF): last alive team/player wins
    if (_lanGameResult === null && !_ctfMode) {
      const allPeersDead = [..._lanPeers.values()].every(p => !p.tank || !p.tank.alive);
      if (!player.alive || allPeersDead) _endLanGame(player.alive && allPeersDead);
    }

    // Wind-down: keep broadcasting until timer expires, then transition
    if (_lanEndTimer > 0) {
      _lanEndTimer -= dt;
      _lanBroadTimer -= dt;
      if (_lanBroadTimer <= 0) {
        _lanBroadTimer = 1 / LAN_SNAP_HZ;
        _lanNet.sendSnapshot({
          players: _buildLanSnapshot(),
          shells:  _buildShellSnapshot(),
          ev: [], ts: Date.now(), rtt: _lanRtt, res: _lanGameResult,
        });
      }
      if (_lanEndTimer <= 0) {
        _lanGameActive = false;
        game.state = _lanGameResult === 'local' ? STATES.VICTORY : STATES.GAME_OVER;
        updateOverlay();
        return;
      }
    }

  } else {
    // ── Client: local prediction + send input + apply host snapshot ────────────
    if (player.alive) player.update(dt, input);
    _lanNet.sendInput(input, _lanLastSnapTs);

    const snap = _lanNet.consumeSnapshot();
    if (snap) {
      _lanLastSnapTs = snap.ts ?? 0;
      if (snap.rtt !== undefined) _lanRtt = snap.rtt;

      // Play shot effects + CTF events sent by host
      if (snap.ev) {
        for (const ev of snap.ev) {
          if      (ev.t === 'fl')  particles.muzzleFlash(ev.x, ev.y, ev.z);
          else if (ev.t === 'ex')  particles.explosion(ev.x, ev.y, ev.z);
          else if (ev.t === 'rc')  particles.ricochet(ev.x, ev.y, ev.z);
          else if (ev.t === 'ctf') _processCtfEvent(ev.ev);
        }
      }

      // Apply authoritative CTF state
      if (_ctfMode && snap.ctf) {
        _ctf.applyState(snap.ctf, _buildCtfPlayerList());
      }

      // Apply authoritative states for all players
      if (snap.players) {
        const myId = _lanNet.id;
        // Own tank correction
        const myState = snap.players[myId];
        if (myState) {
          const wasAlive = player.alive;
          player.applyState(myState);
          if (wasAlive && !player.alive) _processTankDeath(player, null);
        }
        // Peer tanks
        for (const [id, peer] of _lanPeers) {
          const st = snap.players[id];
          if (st && peer.tank) {
            const wasAlive = peer.tank.alive;
            peer.tank.applyState(st);
            if (wasAlive && !peer.tank.alive) _processTankDeath(peer.tank, null);
          }
        }
      }

      // Apply ghost shell positions from snapshot
      _applyGhostShells(snap.shells ?? []);

      // End condition: host authoritative via res field
      // 'local' = host won; from client's perspective that means they lost
      if (snap.res) _endLanGame(snap.res !== 'local');
    }

    // Integrate ghost shell positions between snapshots using last known velocity
    for (const gs of _lanGhostShells) {
      if (!gs.mesh.visible) continue;
      gs.vy -= CONFIG.GRAVITY * dt;
      gs.mesh.position.x += gs.vx * dt;
      gs.mesh.position.y += gs.vy * dt;
      gs.mesh.position.z += gs.vz * dt;
      _ghostShellVel.set(gs.vx, gs.vy, gs.vz).normalize();
      gs.mesh.quaternion.setFromUnitVectors(_ghostShellFwd, _ghostShellVel);
    }

    if (player.alive) player.updateCamera(camera, dt);
  }

  particles.update(dt);

  // ── CTF visual update (both host and client) ──────────────────────────────────
  if (_ctfMode) {
    _ctf.updateVisuals(dt, _buildCtfPlayerList());
    _updateCtfHud();
  }

  // ── LAN peer name tags (one per peer) ─────────────────────────────────────────
  const sw = renderer.domElement.clientWidth;
  const sh = renderer.domElement.clientHeight;
  // Helper: project a tank position to screen and update a nametag element
  function _updateNametag(el, tank, name, team) {
    if (!el) return;
    if (!tank || !tank.alive) { el.style.display = 'none'; return; }
    _lanNametagPos.copy(tank.position);
    _lanNametagPos.y += 2.75 * tank.def.modelScale;
    _lanNametagPos.project(camera);
    const sx = (_lanNametagPos.x + 1) * 0.5 * sw;
    const sy = (-_lanNametagPos.y + 1) * 0.5 * sh;
    if (_lanNametagPos.z < 1 && sx > 0 && sx < sw && sy > 0 && sy < sh) {
      const hpPct = Math.max(0, Math.round(tank.hp / tank.maxHp * 100));
      const tc    = LAN_TEAM_COLORS[team] ?? LAN_TEAM_COLORS[0];
      const tHex  = '#' + tc.toString(16).padStart(6, '0');
      el.innerHTML = `<span class="nt-name" style="color:${tHex}">${name}</span>` +
        `${tank.def.name}` +
        `<span class="nt-hp"><span class="nt-hp-fill" style="width:${hpPct}%"></span></span>`;
      el.style.display = 'block';
      el.style.left = `${sx}px`;
      el.style.top  = `${sy}px`;
    } else {
      el.style.display = 'none';
    }
  }
  for (const [, peer] of _lanPeers) {
    _updateNametag(peer.nametagEl, peer.tank, peer.name, peer.team);
  }
  // Own nametag
  if (_lanSelfNametagEl && _lanGameActive) {
    const _myEntry = _lanRoster.get(_lanNet?.id);
    _updateNametag(_lanSelfNametagEl, player, _lanPlayerName, _myEntry?.team ?? _lanMyTeam ?? 0);
  }

  // ── LAN HUD (~2 Hz) ──────────────────────────────────────────────────────────
  fpsCount++;
  if (now - fpsTime >= 500) {
    const fps = Math.round(fpsCount / ((now - fpsTime) / 1000));
    fpsCount = 0; fpsTime = now;
    if (hudFps)     hudFps.textContent  = `${fps}`;
    if (hudMode)    hudMode.textContent = `LAN  ·  ${_lanRtt}ms`;
    if (hudHp) {
      const pct = Math.round(player.hp / player.maxHp * 100);
      hudHp.textContent = `HP ${pct}%`;
      hudHp.style.color = pct > 50 ? 'rgba(120,255,120,0.85)'
                        : pct > 25 ? 'rgba(255,200,80,0.9)'
                        :            'rgba(255,80,80,0.95)';
    }
    if (hudReload) {
      if (player.reloadTimer >= player.reloadTime) {
        hudReload.textContent = '● READY';
        hudReload.style.color = 'rgba(120,255,120,0.85)';
      } else {
        const pct = Math.round(player.reloadTimer / player.reloadTime * 100);
        hudReload.textContent = `◦ RELOADING ${pct}%`;
        hudReload.style.color = 'rgba(180,180,180,0.5)';
      }
    }
  }
  updateMinimap();
}

const LAN_TEAM_NAMES  = ['Gold', 'Blue', 'Red', 'Green'];

function _lanTeamSelHtml(selectId, val = 0) {
  return `<select id="${selectId}" class="lan-team-sel">` +
    LAN_TEAM_NAMES.map((n, i) => `<option value="${i}"${i === val ? ' selected' : ''}>${n} Team</option>`).join('') +
    `</select>`;
}

function lanLobbyHtml() {
  // Waiting room: show once we have a room code
  const inRoom = !!_lanRoomCode && _lanMode;
  const isHost = _lanNet && _lanNet.isHost();

  // Build roster HTML for waiting room
  let rosterHtml = '';
  if (inRoom) {
    rosterHtml = '<div class="lan-waiting-room">';
    rosterHtml += `<div class="lan-waiting-title">Room <b>${_lanRoomCode}</b>  ·  ${_lanRoster.size} / ${_lanMaxPlayers} players</div>`;
    rosterHtml += '<div class="lan-waiting-list">';
    for (const [id, p] of _lanRoster) {
      const tc = LAN_TEAM_COLORS[p.team ?? 0] ?? LAN_TEAM_COLORS[0];
      const tHex = '#' + tc.toString(16).padStart(6, '0');
      const you = id === (_lanNet && _lanNet.id) ? ' (you)' : '';
      rosterHtml += `<div class="lan-waiting-player">` +
        `<span class="lan-waiting-dot" style="background:${tHex}"></span>` +
        `<span class="lan-waiting-name">${p.name || id}${you}</span>` +
        `<span class="lan-waiting-team" style="color:${tHex}">${LAN_TEAM_NAMES[p.team ?? 0]}</span>` +
        `</div>`;
    }
    rosterHtml += '</div>';
    if (isHost) {
      const canStart = _lanRoster.size >= 2;
      rosterHtml += `<button id="lan-start-btn" class="lan-btn${canStart ? '' : ' lan-btn-disabled'}" ${canStart ? '' : 'disabled'}>Start Game</button>`;
    } else {
      rosterHtml += `<div class="lan-desc">Waiting for host to start…</div>`;
    }
    rosterHtml += '</div>';
  }

  if (inRoom) {
    return `
      <div class="lan-lobby">
        ${rosterHtml}
        <div class="lan-name-row" style="margin-top:10px">
          <label class="lan-name-label">Your team</label>
          ${_lanTeamSelHtml('lan-team-sel-room', _lanMyTeam)}
        </div>
        <div class="lan-status">${_lanStatus}</div>
        <div class="lan-back"><button id="lan-back-btn" class="lan-back-btn">Leave room</button></div>
      </div>`;
  }

  return _onlinePreRoomHtml();
}

/** Generate a random 4-character room code (no ambiguous chars O/0/I/1). */
function _genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── Between-battle advance ────────────────────────────────────────────────────
function advanceAttritionBattle() {
  _attritionBattle++;
  clearCraters(); _resetSmoke(); _resetArtillery(); _resetSpotter();
  game.startFresh();
  spawnAttritionBattle();
  updateOverlay();
}

function advanceStrategyBattle() {
  _strategyLevel++;
  _strategyBudget = STRATEGY_BUDGETS[Math.min(_strategyLevel, STRATEGY_BUDGETS.length - 1)];
  // Clean up objective
  if (_objectiveMesh) { scene.remove(_objectiveMesh); _objectiveMesh.geometry.dispose(); _objectiveMesh = null; }
  _objectivePos = null;
  // Dispose old squad
  for (const t of _playerSquad) t.dispose(scene);
  _playerSquad = [];
  // Go back to purchase screen
  _purchaseSquad = {};
  _purchaseSelIdx = 0;
  for (const k of _strategyRoster()) _purchaseSquad[k] = 0;
  game.state = STATES.PURCHASE;
  updateOverlay();
}

// ─── Arcade kill tracker (called on each enemy death) ─────────────────────────
function _arcadeKillTracked() {
  if (_gameMode !== MODES.ARCADE) return;
  _arcadeKills++;
  if (!_upgradeAvailable && _arcadeClass < ARCADE_CLASSES.length - 1 && _arcadeKills >= KILLS_TO_UPGRADE) {
    _upgradeAvailable = true;
    if (hudHitIndicator) {
      hudHitIndicator.textContent = '▲  UPGRADE READY — Press U to upgrade tank';
      hudHitIndicator.style.color = 'rgba(255, 240, 80, 0.95)';
      hudHitIndicator.style.opacity = '1';
      _hitIndTimer = 9999;  // hold until upgrade is taken
    }
  }
}

// ─── Perform the pending arcade upgrade ───────────────────────────────────────
function _doArcadeUpgrade() {
  if (!_upgradeAvailable) return;
  _upgradeAvailable = false;
  _arcadeClass++;
  _arcadeKills = 0;
  const faction = _selectedFaction();
  const newType = ARCADE_CLASSES[_arcadeClass][faction];
  reinitPlayer(newType);
  if (hudHitIndicator) {
    const cls = ['LIGHT', 'MEDIUM', 'MEDIUM-HEAVY', 'HEAVY'][_arcadeClass];
    hudHitIndicator.textContent = `▲  UPGRADED — ${player.def.name.toUpperCase()} (${cls} CLASS)`;
    hudHitIndicator.style.color = 'rgba(255, 240, 80, 0.95)';
    hudHitIndicator.style.opacity = '1';
    _hitIndTimer = 4.0;
  }
}

// ─── Combat / Particles ────────────────────────────────────────────────────────
const combat    = new CombatManager(scene);
const particles = new ParticleSystem(scene);

// ─── Game state ───────────────────────────────────────────────────────────────
const game  = new GameManager();
const audio = new AudioManager();

// ─── Resize ───────────────────────────────────────────────────────────────────
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);
onResize();

// ─── HUD elements ─────────────────────────────────────────────────────────────
const hudName    = document.getElementById('hud-tank-name');
const hudFaction = document.getElementById('hud-faction');
const hudSpeed   = document.getElementById('hud-speed');
const hudHeading = document.getElementById('hud-heading');
const hudPos     = document.getElementById('hud-pos');
const hudFps     = document.getElementById('hud-fps');
const hudReload  = document.getElementById('hud-reload');
const hudHp      = document.getElementById('hud-hp');
const hudScore   = document.getElementById('hud-score');
const hudEnemies = document.getElementById('hud-enemies');
const hudPhase   = document.getElementById('hud-phase');
const hudMode    = document.getElementById('hud-mode');
const hudSmoke      = document.getElementById('hud-smoke');
const hudSpotter    = document.getElementById('hud-spotter');
const hudAmmo       = document.getElementById('hud-ammo');
const hudArty       = document.getElementById('hud-arty');
const hudLives      = document.getElementById('hud-lives');
const hudSpeedState = document.getElementById('hud-speed-state');

// ─── Overlay elements ─────────────────────────────────────────────────────────
const overlay         = document.getElementById('overlay');
const overlayTitle    = document.getElementById('overlay-title');
const overlaySub      = document.getElementById('overlay-sub');
const overlayControls = document.getElementById('overlay-controls');
const overlayScore    = document.getElementById('overlay-score');
const overlayHint     = document.getElementById('overlay-hint');
const hudEdgeWarning  = document.getElementById('hud-edge-warning');
const hudHitIndicator   = document.getElementById('hud-hit-indicator');
const hudEncounter      = document.getElementById('hud-encounter');
const hudTankNameFlash  = document.getElementById('hud-tank-name-flash');
let   _tankNameFlashTimer = 0;
const hudSight        = document.getElementById('hud-sight');
const hudDamageFlash  = document.getElementById('hud-damage-flash');
const hudTarget       = document.getElementById('hud-target');
const hudTargetName   = document.getElementById('hud-target-name');
const hudTargetBar    = document.getElementById('hud-target-bar');
let _hitIndTimer = 0;

// ─── Recovery HUD elements (created dynamically) ───────────────────────────────
const _hudRecoveryPrompt = (() => {
  const d = document.createElement('div');
  Object.assign(d.style, {
    position: 'absolute', bottom: '28%', left: '50%', transform: 'translateX(-50%)',
    color: 'rgba(80,160,80,0.90)', font: '13px "Courier New",monospace',
    pointerEvents: 'none', display: 'none', textAlign: 'center',
  });
  document.getElementById('hud').appendChild(d);
  return d;
})();
const _hudRecoveryBar = (() => {
  const d = document.createElement('div');
  Object.assign(d.style, {
    position: 'absolute', bottom: '22%', left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.80)', border: '1px solid rgba(100,200,100,0.20)',
    padding: '7px 18px', color: 'rgba(80,160,80,0.95)',
    font: 'bold 19px "Courier New",monospace',
    pointerEvents: 'none', display: 'none', textAlign: 'center', minWidth: '320px',
  });
  document.getElementById('hud').appendChild(d);
  return d;
})();

// ─── Encounter messages ───────────────────────────────────────────────────────
const ENCOUNTER_RANGE = 200; // world units before encounter message triggers
const _encounteredEnemies = new Set();
let   _encounterTimer = 0;
function _resetEncounters() { _encounteredEnemies.clear(); _encounterTimer = 0; }
function _showEncounter(playerName, enemyName) {
  if (!hudEncounter) return;
  hudEncounter.textContent = `${playerName} has encountered ${enemyName}`;
  hudEncounter.style.opacity = '1';
  _encounterTimer = 4.0;
}

// Restart the damage-flash CSS animation on re-trigger
if (hudDamageFlash) {
  hudDamageFlash.addEventListener('animationend', () => {
    hudDamageFlash.classList.remove('flash-active');
  });
}

if (hudName)    hudName.textContent    = player.def.name;
if (hudFaction) hudFaction.textContent = _factionLabel(player.def.faction).toUpperCase();
if (hudSmoke)   hudSmoke.textContent   = `SMOKE ${SMOKE_COUNT}`;
if (hudAmmo)    hudAmmo.textContent    = 'AP';
if (hudArty)    hudArty.textContent    = `ARTY ${ARTY_CHARGES}`;

// ─── Difficulty wiring ────────────────────────────────────────────────────────
const DIFF_LEVELS = ['easy', 'normal', 'medium', 'hard'];

function setDifficulty(level) {
  const preset = CONFIG.DIFFICULTY_PRESETS[level];
  Object.assign(DIFFICULTY, preset);
  player.damageMult      = preset.playerDmgMult;
  player.turretSpeedMult = 1.05;   // player always 5% faster than base
  // reloadMult and aimAssistStrength take effect on next reinitPlayer / next battle
}

const diffSlider = document.getElementById('diff-slider');
if (diffSlider) {
  diffSlider.addEventListener('input', () => { setDifficulty(DIFF_LEVELS[diffSlider.value]); _saveSettings(); });
}
setDifficulty('normal');   // default: Normal

// ─── Settings panel wiring ────────────────────────────────────────────────────
const cbSimple    = document.getElementById('cb-simple-controls');
const hudControls = document.getElementById('hud-controls');

function _updateControlsHint() {
  const squad    = _gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY;
  const strategy = _gameMode === MODES.STRATEGY;
  const tabAction = squad ? 'switch tank' : 'ammo (AP/HE)';
  const stratRows = strategy ? [['G', 'smoke'], ['C', 'artillery'], ['X', 'spotter']] : [];

  // Right HUD panel: structured two-column rows
  if (hudControls) {
    const rows = input.simpleMode
      ? [['W/S',   'fwd / back'], ['A/D',   'turn'],      ['Q/E',   'turret'],
         ['Space', 'fire'],       ['Tab',   tabAction],   ['Esc/P', 'pause'],
         ['V',     'gunsight'],   ...stratRows]
      : [['H/N',   'left track fwd/rev'], ['K/M',   'right track fwd/rev'],
         ['Q/E',   'turret'],             ['Space', 'fire'],
         ['Tab',   tabAction],            ['P',     'pause'],
         ['V',     'gunsight'],           ...stratRows];
    hudControls.innerHTML = rows
      .map(([k, a]) => `<div class="hir-row"><span class="hir-key">${k}</span><span class="hir-action">${a}</span></div>`)
      .join('');
  }

  // Settings panel reference — kept in sync
  const tabDesc = squad ? 'Tab \u00B7 switch tank' : 'Tab \u00B7 ammo (AP/HE)';
  const stratRef = strategy ? ` &nbsp; <kbd>G</kbd> smoke &nbsp; <kbd>C</kbd> artillery &nbsp; <kbd>X</kbd> spotter` : '';
  const ref = document.getElementById('settings-ctrl-ref');
  if (!ref) return;
  if (input.simpleMode) {
    ref.innerHTML =
      `<kbd>W</kbd>/<kbd>S</kbd> forward/back &nbsp; <kbd>A</kbd>/<kbd>D</kbd> turn<br>` +
      `<kbd>Q</kbd>/<kbd>E</kbd> turret left/right &nbsp; <kbd>Space</kbd>/<kbd>F</kbd> fire<br>` +
      `${tabDesc} &nbsp; <kbd>V</kbd> gun sight${stratRef}<br>` +
      `<kbd>Esc</kbd>/<kbd>P</kbd> pause`;
  } else {
    ref.innerHTML =
      `<kbd>H</kbd>/<kbd>N</kbd> left track fwd/rev &nbsp; <kbd>K</kbd>/<kbd>M</kbd> right track fwd/rev<br>` +
      `<kbd>Q</kbd>/<kbd>E</kbd> turret left/right &nbsp; <kbd>Space</kbd>/<kbd>F</kbd> fire<br>` +
      `${tabDesc} &nbsp; <kbd>V</kbd> gun sight${stratRef}<br>` +
      `<kbd>P</kbd> pause`;
  }
}

// ─── Advanced HUD toggle ──────────────────────────────────────────────────────
let _advancedInfo = false;
const _hudInfoLeft = document.getElementById('hud-info-left');

function _applyAdvancedHud(on) {
  _advancedInfo = on;
  if (_hudInfoLeft) _hudInfoLeft.classList.toggle('adv', on);
}

const cbAdvancedInfo = document.getElementById('cb-advanced-info');
if (cbAdvancedInfo) {
  cbAdvancedInfo.addEventListener('change', () => { _applyAdvancedHud(cbAdvancedInfo.checked); _saveSettings(); });
}

// Simple controls are on by default
cbSimple.checked = true;
input.simpleMode = true;

cbSimple.addEventListener('change', () => {
  input.simpleMode = cbSimple.checked;
  _updateControlsHint();
  updateOverlay();
  _saveSettings();
});

// Aim assist (auto-rotate turret) — applies in simple mode only
let _aimAssist = true;
let _manualTurretPauseTimer = 0;  // seconds remaining before auto-turret resumes after Q/E
let _turretIdleTimer = 0;         // seconds since last manual turret input or aim-assist acquisition
const cbAimAssist = document.getElementById('cb-aim-assist');
if (cbAimAssist) {
  cbAimAssist.checked = true;
  cbAimAssist.addEventListener('change', () => { _aimAssist = cbAimAssist.checked; _saveSettings(); });
}

// ─── Friendly fire toggle ─────────────────────────────────────────────────────
const cbFriendlyFire = document.getElementById('cb-friendly-fire');
if (cbFriendlyFire) {
  combat.friendlyFire = true;   // matches checkbox default (checked)
  cbFriendlyFire.addEventListener('change', () => { combat.friendlyFire = cbFriendlyFire.checked; _saveSettings(); });
}

// ─── Weather condition dropdown ────────────────────────────────────────────────
// cb-weather master toggle remains; sel-weather picks Auto/Clear/Rain/Fog/Dust.
const cbWeather  = document.getElementById('cb-weather');
const selWeather = document.getElementById('sel-weather');
function _applyWeatherSettings() {
  const enabled = cbWeather?.checked ?? true;
  const rowSel  = document.getElementById('row-weather-sel');
  if (rowSel) rowSel.style.opacity = enabled ? '' : '0.4';
  if (!enabled) {
    weather.setForced('clear');
    return;
  }
  weather.setForced(selWeather?.value ?? 'auto');
}
if (cbWeather)  cbWeather.addEventListener('change',  () => { _applyWeatherSettings(); _saveSettings(); });
if (selWeather) selWeather.addEventListener('change', () => { _applyWeatherSettings(); _saveSettings(); });

// ─── Mercenaries toggle ───────────────────────────────────────────────────────
let _mercsEnabled = false;

// Custom stat + visual overrides for the Obliterator (player-editable)
const _mercCustomStats = {};
const _OBLITERATOR_KEY = 'treads_obliterator_v1';

function _obliteratorDefaults() {
  const d = CONFIG.TANK_DEFS.obliterator;
  return {
    // Identity
    customName: '',
    // Combat
    frontArmour: d.frontArmour,
    sideArmour:  d.sideArmour,
    rearArmour:  d.rearArmour,
    firepower:   d.firepower,
    reloadTime:  d.reloadTime,
    turretSpeed: d.turretSpeed,
    accuracy:    d.accuracy,
    // Mobility
    maxSpeed:    d.maxSpeed,
    xcSpeed:     d.xcSpeed,
    accel:       d.accel,
    turnRate:    d.turnRate,
    // Visual
    bodyScaleXZ:   1.0,
    bodyScaleY:    1.0,
    bodyRaise:     0.0,
    turretScaleXZ: 1.0,
    turretScaleY:  1.0,
    turretRaise:   0.0,
    gunLengthMult: 1.0,
    gunRadiusMult: 1.0,
  };
}

function _getMercObliteratorStats() {
  if (!_mercCustomStats.obliterator) {
    _mercCustomStats.obliterator = _obliteratorDefaults();
    // Load persisted values
    try {
      const saved = JSON.parse(localStorage.getItem(_OBLITERATOR_KEY) || 'null');
      if (saved && typeof saved === 'object') Object.assign(_mercCustomStats.obliterator, saved);
    } catch { /**/ }
  }
  return _mercCustomStats.obliterator;
}

function _saveObliteratorStats() {
  try { localStorage.setItem(_OBLITERATOR_KEY, JSON.stringify(_mercCustomStats.obliterator || {})); } catch { /**/ }
}
const cbMercs = document.getElementById('cb-mercenaries');
if (cbMercs) {
  cbMercs.checked = false;
  cbMercs.addEventListener('change', () => {
    _mercsEnabled = cbMercs.checked;
    if (!_mercsEnabled && _faction === 'mercenary') _setFaction('american');
    updateOverlay();
    _saveSettings();
  });
}

// ─── Merc Tank Editor toggle ──────────────────────────────────────────────────
let _mercEditorEnabled = false;
let _mercEditorOpen    = false;
const cbMercEditor = document.getElementById('cb-merc-editor');
if (cbMercEditor) {
  cbMercEditor.checked = false;
  cbMercEditor.addEventListener('change', () => {
    _mercEditorEnabled = cbMercEditor.checked;
    updateOverlay();
    _saveSettings();
  });
}

// ─── LAN enabled toggle ───────────────────────────────────────────────────────
let _lanEnabled = false;
const cbLan = document.getElementById('cb-lan');
if (cbLan) {
  cbLan.checked = false;
  cbLan.addEventListener('change', () => {
    _lanEnabled = cbLan.checked;
    updateOverlay();
    _saveSettings();
  });
}

// ─── LAN networking state ─────────────────────────────────────────────────────
let _lanMode        = false;  // true while a LAN session is set up or in progress
let _lanNet         = null;   // Net instance
let _lanBroadTimer  = 0;      // countdown to next broadcast (host only)
let _lanGameActive  = false;  // true once all tanks are spawned and game is running
let _lanTankKey     = null;   // this player's selected tank key for LAN
let _lanStatus      = '';     // display string for lobby screen
let _lanEvents      = [];     // muzzle/explosion events pending next broadcast (host)
let _lanGameResult  = null;   // null | winner id string
let _lanEndTimer    = -1;     // host: seconds remaining in wind-down broadcast (-1 = inactive)
let _lanRtt         = 0;      // round-trip time in ms (from host measurement)
let _lanLastSnapTs  = 0;      // client: ts of last received snapshot (echoed to host)
let _lanPlayerName  = '';     // this player's chosen name
let _lanMyTeam      = 0;      // this player's team (0–3)
let _lanMaxPlayers  = 2;      // max players in the room (host sets, 2–16)
let _lanRoomCode    = '';     // 4-char room code for this session
let _lanStarted     = false;  // lobby→game transition guard
// Map<id, { tank: Tank, name: string, team: number, tankKey: string, nametagEl: HTMLElement }>
let _lanPeers       = new Map();
let _lanSelfNametagEl = null;  // nametag shown above the local player's own tank
// Lobby roster (pre-game): Map<id, { name, team, tankKey }>
let _lanRoster      = new Map();
const _lanNametagPos = new THREE.Vector3();  // reused for screen projection

// CTF state
let _ctfMode  = false;        // true when this LAN session uses Capture the Flag
const _ctf    = new CTFManager(scene);  // singleton; init() called per game

// Team colours (index 0–3) — applied as colorOverride on peer tanks
const LAN_TEAM_COLORS = [0xD4B822, 0x3A8FE8, 0xE83A3A, 0x3AE85A];

// Ghost shells — client-side visual tracers replicated from host snapshots
const _ghostShellGeo = new THREE.BoxGeometry(0.15, 0.15, 10);
const _ghostShellFwd = new THREE.Vector3(0, 0, 1);
const _ghostShellVel = new THREE.Vector3();
let   _lanGhostShells = [];  // { mesh: THREE.Mesh, vx, vy, vz }

// ─── Demo mode ────────────────────────────────────────────────────────────────
// When enabled in Settings and no player input has been received, the AI drives
// the player tank. First actual input from the player disables demo for the session.
let _demoEnabled = true;
let _demoActive  = false;   // true = AI is currently driving the player
let _demoAI      = null;    // AIController instance for the player (created on game start)

const cbDemo = document.getElementById('cb-demo');
if (cbDemo) {
  cbDemo.checked = false;
  cbDemo.addEventListener('change', () => { _demoEnabled = cbDemo.checked; _saveSettings(); });
}

// ─── Debug mode ───────────────────────────────────────────────────────────────
let _debugMode       = false;
let _debugAiDisabled = false;
const _debugPanel = document.getElementById('debug-panel');
// Single delegated pointerdown listener on the stable panel container.
// All buttons inside are recreated every frame via innerHTML. Using pointerdown
// (fires on initial press) rather than click, because click requires mousedown and
// mouseup on a common ancestor — when innerHTML is rebuilt between them the mousedown
// target is detached, so no common ancestor exists and click never fires.
if (_debugPanel) {
  _debugPanel.addEventListener('pointerdown', e => {
    const btn = e.target.closest('.dbg-adj');
    if (!btn) return;
    if (btn.id === 'dbg-ai-toggle') {
      _debugAiDisabled = !_debugAiDisabled;
      return;
    }
    if (!player?.def) return;
    const stat  = btn.dataset.stat;
    const delta = parseFloat(btn.dataset.delta);
    const min   = parseFloat(btn.dataset.min);
    const max   = parseFloat(btn.dataset.max);
    player.def[stat] = Math.round((player.def[stat] + delta) * 100) / 100;
    player.def[stat] = Math.max(min, Math.min(max, player.def[stat]));
    // Apply cached derived values immediately so changes take effect this frame
    if (stat === 'maxSpeed') player.maxSpeed = player.def.maxSpeed * 0.20;
    if (stat === 'xcSpeed')  player.xcSpeed  = player.def.xcSpeed  * 0.20;
    if (stat === 'reloadTime') player.reloadTime = player.def.reloadTime;
    // Restore to full HP so armour/firepower changes can be tested cleanly
    player.hp = player.maxHp;
    if (!player.alive) { player.alive = true; }
    const el = document.getElementById(`dbv-${stat}`);
    const unit = stat === 'maxSpeed' || stat === 'xcSpeed' ? ' km/h' : '';
    const v = player.def[stat];
    if (el) el.textContent = (Number.isInteger(v) ? v : v.toFixed(Math.abs(delta) < 0.1 ? 2 : 1)) + unit;
  });
}

function _applyDebugMode(on) {
  _debugMode = on;
  if (on) {
    // Force advanced info on and demo off when debug is enabled
    if (cbAdvancedInfo && !cbAdvancedInfo.checked) { cbAdvancedInfo.checked = true; _applyAdvancedHud(true); }
    if (cbDemo && cbDemo.checked) { cbDemo.checked = false; _demoEnabled = false; }
  }
  // Panel visibility is handled by the game loop — no update call here (gm may not exist yet)
}

function _debugStatRow(label, stat, step, min, max, unit) {
  const v    = player?.def?.[stat] ?? 0;
  const disp = Number.isInteger(v) ? v : v.toFixed(step < 0.1 ? 2 : 1);
  return `<div class="dbg-row">` +
    `<span class="dbg-label">${label}</span>` +
    `<button class="dbg-adj" data-stat="${stat}" data-delta="${-step}" data-min="${min}" data-max="${max}">−</button>` +
    `<span class="dbg-val" id="dbv-${stat}">${disp}${unit ?? ''}</span>` +
    `<button class="dbg-adj" data-stat="${stat}" data-delta="${step}" data-min="${min}" data-max="${max}">+</button>` +
    `</div>`;
}

function _updateDebugPanel() {
  if (!_debugPanel) return;
  // Check _debugMode first — it defaults false, so this exits before game is initialised
  if (!_debugMode) { _debugPanel.classList.remove('dbg-visible'); return; }
  // Panel is always visible while debug mode is on — only hide when mode is off
  _debugPanel.classList.add('dbg-visible');
  // Only rebuild content when playing with an alive player
  if (game.state !== STATES.PLAYING || !player?.alive) return;
  const aiLabel = _debugAiDisabled ? 'AI: OFF' : 'AI: ON';
  const aiActiveStyle = _debugAiDisabled ? 'background:rgba(160,20,20,0.90);border-color:rgba(255,80,80,0.50);' : 'background:rgba(160,20,20,0.70);border-color:rgba(255,80,80,0.40);';
  _debugPanel.innerHTML = `<div class="dbg-title">DEBUG — ${player.def.name}</div>` +
    `<div class="dbg-row" style="padding:4px 8px 2px">` +
      `<button class="dbg-adj" id="dbg-ai-toggle" style="width:100%;height:auto;padding:3px 0;font-size:13px;letter-spacing:0.10em;color:rgba(255,160,140,0.95);${aiActiveStyle}">${aiLabel}</button>` +
    `</div>` +
    `<div class="dbg-section">MOBILITY</div>` +
    _debugStatRow('Top speed', 'maxSpeed', 5, 5, 200, ' km/h') +
    _debugStatRow('XC speed',  'xcSpeed',  5, 5, 200, ' km/h') +
    _debugStatRow('Accel',     'accel',    5, 5, 200) +
    _debugStatRow('Turn rate', 'turnRate', 5, 5, 200) +
    `<div class="dbg-section">COMBAT</div>` +
    _debugStatRow('Front armour', 'frontArmour', 5, 5, 200) +
    _debugStatRow('Side armour',  'sideArmour',  5, 5, 200) +
    _debugStatRow('Rear armour',  'rearArmour',  5, 5, 200) +
    _debugStatRow('Firepower',    'firepower',   5, 5, 200) +
    _debugStatRow('Reload (s)',   'reloadTime',  0.5, 0.5, 10);

}
// (all button interaction handled by the delegated listener on _debugPanel below)

const cbDebug = document.getElementById('cb-debug');
if (cbDebug) {
  cbDebug.checked = false;
  cbDebug.addEventListener('change', () => { _applyDebugMode(cbDebug.checked); _saveSettings(); });
}

// ─── Water toggle ─────────────────────────────────────────────────────────────
let _waterEnabled = true;
const cbWater = document.getElementById('cb-water');
if (cbWater) {
  cbWater.checked = true;
  cbWater.addEventListener('change', () => {
    _waterEnabled = cbWater.checked;
    _saveSettings();
    // Show/hide pond overlay meshes
    for (const m of _waterMeshes) m.visible = _waterEnabled;
    // Rebuild terrain chunks so sea-level tiles recolour immediately
    setTerrainWaterEnabled(_waterEnabled);
    chunkManager.dispose();
    chunkManager.update(player.position.x, player.position.z);
  });
}

// ─── Mouse aiming ─────────────────────────────────────────────────────────────
let _mouseAimEnabled = false;
let _mouseX          = 0;
let _mouseY          = 0;
let _mouseFireOnce   = false;

const _aimRaycaster = new THREE.Raycaster();
const _aimHitPoint  = new THREE.Vector3();
const _aimPlane     = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

document.addEventListener('mousemove', e => { _mouseX = e.clientX; _mouseY = e.clientY; });
document.addEventListener('mousedown', e => {
  if (e.button === 0 && _mouseAimEnabled && game?.isPlaying) _mouseFireOnce = true;
});

const cbMouseAim = document.getElementById('cb-mouse-aim');
function _applyMouseAimState() {
  if (!cbMouseAim) return;
  _mouseAimEnabled = cbMouseAim.checked;
  // Grey out the aim-assist row when mouse aiming is active (it's overridden by mouse)
  const aimRow = cbAimAssist?.closest('.settings-row, .settings-diff');
  if (aimRow) aimRow.style.opacity = cbMouseAim.checked ? '0.4' : '';
  if (cbAimAssist) cbAimAssist.disabled = cbMouseAim.checked;
}
if (cbMouseAim) {
  cbMouseAim.checked = false;
  cbMouseAim.addEventListener('change', () => { _applyMouseAimState(); _saveSettings(); });
}

// ─── Persisted settings (localStorage) ────────────────────────────────────────
const _SETTINGS_KEY = 'treads_settings';
const _FACTORY_DEFAULTS = { simple:true, aimAssist:true, advancedInfo:false, mercs:false, mercEditor:false, friendlyFire:true, demo:false, lan:true, debug:false, water:true, mouseAim:false, difficulty:2, weatherEnabled:true, weather:'auto' };

function _saveSettings() {
  const s = {
    simple:       cbSimple?.checked       ?? _FACTORY_DEFAULTS.simple,
    aimAssist:    cbAimAssist?.checked    ?? _FACTORY_DEFAULTS.aimAssist,
    advancedInfo: cbAdvancedInfo?.checked ?? _FACTORY_DEFAULTS.advancedInfo,
    mercs:        cbMercs?.checked        ?? _FACTORY_DEFAULTS.mercs,
    mercEditor:   cbMercEditor?.checked   ?? _FACTORY_DEFAULTS.mercEditor,
    friendlyFire: cbFriendlyFire?.checked ?? _FACTORY_DEFAULTS.friendlyFire,
    demo:         cbDemo?.checked         ?? _FACTORY_DEFAULTS.demo,
    lan:          cbLan?.checked          ?? _FACTORY_DEFAULTS.lan,
    debug:        cbDebug?.checked        ?? _FACTORY_DEFAULTS.debug,
    water:        cbWater?.checked        ?? _FACTORY_DEFAULTS.water,
    mouseAim:     cbMouseAim?.checked     ?? _FACTORY_DEFAULTS.mouseAim,
    difficulty:   diffSlider ? parseInt(diffSlider.value) : _FACTORY_DEFAULTS.difficulty,
    weatherEnabled: cbWeather?.checked  ?? _FACTORY_DEFAULTS.weatherEnabled,
    weather:        selWeather?.value   ?? _FACTORY_DEFAULTS.weather,
  };
  try { localStorage.setItem(_SETTINGS_KEY, JSON.stringify(s)); } catch { /**/ }
}

function _loadSettings() {
  let s = { ..._FACTORY_DEFAULTS };
  try { Object.assign(s, JSON.parse(localStorage.getItem(_SETTINGS_KEY) || '{}')); } catch { /**/ }
  if (cbSimple)       { cbSimple.checked = s.simple;             input.simpleMode = s.simple; _updateControlsHint(); }
  if (cbAimAssist)    { cbAimAssist.checked = s.aimAssist;       _aimAssist = s.aimAssist; }
  if (cbAdvancedInfo) { cbAdvancedInfo.checked = s.advancedInfo; _applyAdvancedHud(s.advancedInfo); }
  if (cbMercs)        { cbMercs.checked = s.mercs;               _mercsEnabled = s.mercs; }
  if (cbMercEditor)   { cbMercEditor.checked = s.mercEditor;     _mercEditorEnabled = s.mercEditor; }
  if (cbFriendlyFire) { cbFriendlyFire.checked = s.friendlyFire; combat.friendlyFire = s.friendlyFire; }
  if (cbDemo)         { cbDemo.checked = s.demo;                 _demoEnabled = s.demo; }
  if (cbLan)          { cbLan.checked = s.lan;                   _lanEnabled = s.lan; }
  if (cbDebug)        { cbDebug.checked = s.debug;               _applyDebugMode(s.debug); }
  if (cbWater)        { cbWater.checked = s.water ?? true;       _waterEnabled = s.water ?? true; setTerrainWaterEnabled(_waterEnabled); }
  if (cbMouseAim)     { cbMouseAim.checked = s.mouseAim ?? false; _applyMouseAimState(); }
  if (diffSlider)     { diffSlider.value = s.difficulty;         setDifficulty(DIFF_LEVELS[s.difficulty]); }
  if (cbWeather)      { cbWeather.checked = s.weatherEnabled ?? true; }
  if (selWeather)     { selWeather.value  = s.weather ?? 'auto'; }
  _applyWeatherSettings();
  const btnReset = document.getElementById('btn-reset-defaults');
  if (btnReset) btnReset.addEventListener('click', () => {
    try { localStorage.removeItem(_SETTINGS_KEY); localStorage.removeItem(_OBLITERATOR_KEY); } catch { /**/ }
    location.reload();
  });
  _updateSettingsHighlights();
}

// Highlight settings labels yellow when their value differs from the factory default.
function _updateSettingsHighlights() {
  const items = [
    [cbSimple,       'simple',         el => el.checked],
    [cbAimAssist,    'aimAssist',      el => el.checked],
    [cbMouseAim,     'mouseAim',       el => el.checked],
    [cbAdvancedInfo, 'advancedInfo',   el => el.checked],
    [cbMercs,        'mercs',          el => el.checked],
    [cbMercEditor,   'mercEditor',     el => el.checked],
    [cbFriendlyFire, 'friendlyFire',   el => el.checked],
    [cbDemo,         'demo',           el => el.checked],
    [cbLan,          'lan',            el => el.checked],
    [cbDebug,        'debug',          el => el.checked],
    [cbWater,        'water',          el => el.checked],
    [cbWeather,      'weatherEnabled', el => el.checked],
    [selWeather,     'weather',        el => el.value],
    [diffSlider,     'difficulty',     el => parseInt(el.value)],
  ];
  for (const [el, key, getValue] of items) {
    if (!el) continue;
    const row = el.closest('.settings-row, .settings-diff');
    if (!row) continue;
    const label = row.querySelector('.settings-label');
    if (!label) continue;
    label.style.color = (getValue(el) === _FACTORY_DEFAULTS[key]) ? '' : 'rgba(255,220,50,0.95)';
  }
}

// Update highlights whenever any setting control changes
{
  const _settingsPane = document.getElementById('sp-settings');
  if (_settingsPane) {
    _settingsPane.addEventListener('change', _updateSettingsHighlights);
    _settingsPane.addEventListener('input',  _updateSettingsHighlights);
  }
}

_loadSettings();

// Disable demo on ANY user interaction — keyboard, mouse, or touch
function _cancelDemo() {
  if (_demoActive) { _demoActive = false; _demoAI = null; }
}
window.addEventListener('keydown',    _cancelDemo, { passive: true });
window.addEventListener('mousedown',  _cancelDemo, { passive: true });
window.addEventListener('touchstart', _cancelDemo, { passive: true });

// ─── Arcade lives icon canvas ────────────────────────────────────────────────
const _livesCanvas = document.getElementById('hud-lives-icons');
const _livesCtx    = _livesCanvas && _livesCanvas.getContext('2d');

// Draw King Tiger side-view silhouette. Gun points LEFT (forward).
// Axis dunkelgelb fill (#D4B822) with black outline when active; ghost when lost.
function _drawTankIcon(ctx, cx, cy, filled) {
  const fill   = filled ? '#D4B822' : 'rgba(65,68,50,0.22)';
  const stroke = '#1A1A18';
  ctx.lineWidth = 1.5;
  ctx.lineJoin  = 'round';

  // ── Tracks / skirts (widest, lowest layer) ──────────────────────────────
  ctx.beginPath();
  ctx.rect(cx - 27, cy + 8, 54, 7);
  ctx.fillStyle = fill;   ctx.fill();
  ctx.strokeStyle = stroke; ctx.stroke();

  // ── Hull body — angled lower-front plate (King Tiger lower glacis) ──────
  ctx.beginPath();
  ctx.moveTo(cx - 27, cy + 8);   // front lower corner
  ctx.lineTo(cx - 20, cy);        // front upper (sloped glacis)
  ctx.lineTo(cx + 27, cy);        // rear upper
  ctx.lineTo(cx + 27, cy + 8);   // rear lower
  ctx.closePath();
  ctx.fillStyle = fill;   ctx.fill();
  ctx.strokeStyle = stroke; ctx.stroke();

  // ── Turret — boxy, positioned mid-rear (King Tiger Henschel turret) ─────
  ctx.beginPath();
  ctx.rect(cx - 4, cy - 9, 22, 9);
  ctx.fillStyle = fill;   ctx.fill();
  ctx.strokeStyle = stroke; ctx.stroke();

  // ── Gun barrel — very long 88mm KwK 43 ──────────────────────────────────
  ctx.beginPath();
  ctx.rect(cx - 31, cy - 7, 27, 3);
  ctx.fillStyle = fill;   ctx.fill();
  ctx.strokeStyle = stroke; ctx.stroke();
}

// Red X overlay drawn over a lost-life slot
function _drawRedX(ctx, cx, cy) {
  ctx.strokeStyle = '#CC1A0A';
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - 23, cy - 11);  ctx.lineTo(cx + 25, cy + 13);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + 25, cy - 11);  ctx.lineTo(cx - 23, cy + 13);
  ctx.stroke();
}

function _drawLivesIcons() {
  if (!_livesCtx) return;
  const W = _livesCanvas.width, H = _livesCanvas.height;
  _livesCtx.clearRect(0, 0, W, H);
  if (_gameMode !== MODES.ARCADE) return;
  const slots = 3, slotW = W / slots;
  for (let i = 0; i < slots; i++) {
    const icx = slotW * i + slotW / 2;
    const icy = H / 2;
    _drawTankIcon(_livesCtx, icx, icy, i <= _lives);
    if (i > _lives) _drawRedX(_livesCtx, icx, icy);
  }
}

// ─── Controls help HTML for menu overlay ─────────────────────────────────────
function controlsHtml() {
  function row(key, desc) {
    return `<div class="ctrl-row"><span class="ctrl-key">${key}</span><span class="ctrl-desc">${desc}</span></div>`;
  }
  const tip = '<div class="ctrl-tip">&#9776; To view or change controls, open Settings (top left)</div>';
  const squad    = _gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY;
  const strategy = _gameMode === MODES.STRATEGY;
  const tabDesc  = squad ? 'switch tank' : 'switch ammo  (AP / HE)';

  if (input.simpleMode) {
    return [
      row('W / S',     'forward / backward'),
      row('A / D',     'turn left / right'),
      row('Q / E',     'turret left / right'),
      row('Space / F', 'fire'),
      row('Tab',       tabDesc),
      ...(strategy ? [
        row('G', 'smoke grenade  (3 / battle)'),
        row('C', 'artillery support  (2 / battle)'),
        row('X', 'spotter plane  (2 / battle)'),
      ] : []),
      row('Esc / P',   'pause'),
      row('V',         'toggle gun sight  (mouse aims in sight mode)'),
      tip,
    ].join('');
  }
  return [
    row('H / N',     'left track forward / reverse'),
    row('K / M',     'right track forward / reverse'),
    row('Q / E',     'turret left / right'),
    row('Space / F', 'fire'),
    row('Tab',       tabDesc),
    ...(strategy ? [
      row('G', 'smoke grenade  (3 / battle)'),
      row('C', 'artillery support  (2 / battle)'),
      row('X', 'spotter plane  (2 / battle)'),
    ] : []),
    row('P',         'pause'),
    row('V',         'toggle gun sight'),
    tip,
  ].join('');
}

// ─── Tank selection UI ────────────────────────────────────────────────────────
function tankSelectHtml() {
  const key = PLAYER_TANKS[_selIdx];
  const def = CONFIG.TANK_DEFS[key];
  function bar(val, max) {
    const n = Math.min(8, Math.max(0, Math.round(val / max * 8)));
    return '\u25A0'.repeat(n) + '\u25A1'.repeat(8 - n);
  }
  const arrowL = _selIdx > 0                        ? '\u25C4' : '\u00A0';
  const arrowR = _selIdx < PLAYER_TANKS.length - 1  ? '\u25BA' : '\u00A0';
  const reloadDisplay = (def.reloadTime * DIFFICULTY.reloadMult).toFixed(1);
  const reloadBar     = bar(5 - parseFloat(reloadDisplay), 5);
  return [
    `<div class="ts-nav">`,
    `  <span class="ts-arrow">${arrowL}</span>`,
    `  <span class="ts-name">${def.name}</span>`,
    `  <span class="ts-arrow">${arrowR}</span>`,
    `</div>`,
    `<div class="ts-faction">${_factionLabel(def.faction, true)}</div>`,
    `<div class="ts-stats">`,
    `  <div class="ts-row"><span class="ts-label">Armour</span><span class="ts-bar">${bar(def.frontArmour, 100)}</span><span class="ts-val">${def.frontArmour}</span></div>`,
    `  <div class="ts-row"><span class="ts-label">Firepower</span><span class="ts-bar">${bar(def.firepower, 100)}</span><span class="ts-val">${def.firepower}</span></div>`,
    `  <div class="ts-row"><span class="ts-label">Speed</span><span class="ts-bar">${bar(def.maxSpeed, 56)}</span><span class="ts-val">${def.maxSpeed} km/h</span></div>`,
    `  <div class="ts-row"><span class="ts-label">Reload</span><span class="ts-bar">${reloadBar}</span><span class="ts-val">${reloadDisplay}s</span></div>`,
    `</div>`,
    `<div class="ts-counter">${_selIdx + 1} / ${PLAYER_TANKS.length}</div>`,
  ].join('');
}

// ─── Reinitialise player with a different tank type ───────────────────────────
function reinitPlayer(type, colorOverride = null) {
  player.dispose(scene);
  const vis = type === 'obliterator' ? _getMercObliteratorStats() : null;
  player = new Tank(scene, type, false, colorOverride, vis);
  // Apply Obliterator custom stat overrides if set
  if (type === 'obliterator' && _mercCustomStats.obliterator) {
    const cs = _mercCustomStats.obliterator;
    player.def      = { ...player.def, ...cs };
    player.maxSpeed = cs.maxSpeed * 0.20;   // SPEED_SCALE
    player.xcSpeed  = cs.xcSpeed  * 0.20;
    player.accel    = cs.accel    * 0.15;   // ACCEL_SCALE
    player.turnRate = cs.turnRate * 0.003;  // TURN_SCALE
  }
  player.reloadTime      = player.def.reloadTime * DIFFICULTY.reloadMult;
  player.reloadTimer     = player.reloadTime;
  player.damageMult      = DIFFICULTY.playerDmgMult;
  player.turretSpeedMult = 1.05;
  if (hudName)    hudName.textContent    = player.def.name;
  if (hudFaction) hudFaction.textContent = _factionLabel(player.def.faction).toUpperCase();
}

// ─── Combined menu: 2-column vehicle + battle mode selector ──────────────────
// ── Shared: faction + vehicle column HTML (reused in menu and online lobby) ───
function _menuTankColsHtml() {
  const key = ALL_TANKS[_selIdx];
  const def = CONFIG.TANK_DEFS[key];
  function bar(val, max) {
    const n = Math.min(8, Math.max(0, Math.round(val / max * 8)));
    return '\u25A0'.repeat(n) + '\u25A1'.repeat(8 - n);
  }
  const _maxSelIdx = _mercsEnabled ? ALL_TANKS.length - 1 : 11;
  const arrowL = _selIdx > 0 ? '\u25C4' : '\u00A0';
  const arrowR = _selIdx < _maxSelIdx ? '\u25BA' : '\u00A0';

  let html = '';

  // Left column: faction selector
  html += '<div class="menu-col">';
  html += '<div class="menu-section-label">FACTION</div>';
  html += '<div class="faction-select">';
  for (const [fkey, fname] of [['american','Allies'],['russian','Soviets'],['german','Axis'],['mercenary','Mercs']].filter(([k]) => k !== 'mercenary' || _mercsEnabled)) {
    const sel = fkey === _faction;
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
  const cs = isObliterator ? _getMercObliteratorStats() : null;
  const displayName = (isObliterator && cs?.customName) ? cs.customName : def.name;
  html += `<button class="ts-arrow" data-dir="left" ${_selIdx <= 0 ? 'disabled' : ''}>${arrowL}</button>`;
  html += `<span class="ts-name">${displayName}</span>`;
  html += `<button class="ts-arrow" data-dir="right" ${_selIdx >= _maxSelIdx ? 'disabled' : ''}>${arrowR}</button>`;
  html += '</div>';
  const armourVal = cs ? cs.frontArmour : def.frontArmour;
  const fpVal     = cs ? cs.firepower   : def.firepower;
  const spdVal    = cs ? cs.maxSpeed    : def.maxSpeed;
  const rtVal     = cs ? cs.reloadTime  : def.reloadTime;
  const rdDisp    = (rtVal * DIFFICULTY.reloadMult).toFixed(1);
  const rdBar     = bar(5 - parseFloat(rdDisp), 5);
  function adjBtns(stat, minusD, plusD) {
    if (!isObliterator) return '';
    return `<span class="merc-adj-pair">` +
           `<button class="merc-adj" data-stat="${stat}" data-delta="${minusD}">−</button>` +
           `<button class="merc-adj" data-stat="${stat}" data-delta="${plusD}">+</button>` +
           `</span>`;
  }
  if (isObliterator) html += '<div class="ts-customise-label">CUSTOMISE LOADOUT</div>';
  html += '<div class="ts-stats">';
  html += `<div class="ts-row"><span class="ts-label">Armour</span><span class="ts-bar">${bar(armourVal, 100)}</span><span class="ts-val">${armourVal}</span>${adjBtns('frontArmour', -5, 5)}</div>`;
  html += `<div class="ts-row"><span class="ts-label">Firepower</span><span class="ts-bar">${bar(fpVal, 100)}</span><span class="ts-val">${fpVal}</span>${adjBtns('firepower', -5, 5)}</div>`;
  html += `<div class="ts-row"><span class="ts-label">Speed</span><span class="ts-bar">${bar(spdVal, 56)}</span><span class="ts-val">${spdVal} km/h</span>${adjBtns('maxSpeed', -5, 5)}</div>`;
  html += `<div class="ts-row"><span class="ts-label">Reload</span><span class="ts-bar">${rdBar}</span><span class="ts-val">${rdDisp}s</span>${adjBtns('reloadTime', 0.5, -0.5)}</div>`;
  html += '</div>';
  if (isObliterator && _mercEditorEnabled) {
    html += '<button class="merc-edit-btn" id="merc-edit-btn">EDIT</button>';
  }
  html += `<div class="ts-counter">${_selIdx + 1} / ${ALL_TANKS.length}</div>`;
  html += '</div>';

  return html;
}

// ── Shared: wire faction + vehicle arrow interactions ─────────────────────────
// (all interaction handled by the delegated listener on overlayControls below)
function _wireMenuTankControls(_container) { /* no-op */ }

// ── Merc tank editor ─────────────────────────────────────────────────────────
function _mercEditorHtml() {
  const cs  = _getMercObliteratorStats();
  const def = CONFIG.TANK_DEFS.obliterator;

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
    const disp = v.toFixed(step < 0.1 ? 2 : 2);
    return `<div class="me-row">` +
      `<span class="me-label">${label}</span>` +
      `<button class="me-vis" data-prop="${prop}" data-delta="${-step}" data-min="${min}" data-max="${max}">−</button>` +
      `<span class="me-val" id="mev-${prop}">${disp}${unit}</span>` +
      `<button class="me-vis" data-prop="${prop}" data-delta="${step}" data-min="${min}" data-max="${max}">+</button>` +
      `</div>`;
  }

  const rdDisp = (cs.reloadTime * DIFFICULTY.reloadMult).toFixed(1);

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

// (all interaction handled by the delegated listener on overlayControls below)
function _wireMercEditor(_container) { /* no-op */ }

function menuScreenHtml() {
  let html = '<div class="menu-combined">';
  html += _menuTankColsHtml();

  // Right column: mode selector
  html += '<div class="menu-col">';
  html += '<div class="menu-section-label">BATTLE MODE</div>';
  html += '<div class="mode-select">';
  const modeNames = ['Arcade', 'Attrition', 'Strategy', ...(_lanEnabled ? ['Online'] : [])];
  const modeDescs = [
    'Endless waves \u00B7 Solo \u00B7 Tank upgrades by kills \u00B7 3 lives',
    'Fixed squad of 5 \u00B7 Permanent losses \u00B7 Escalating enemy',
    'Budget purchase \u00B7 Objective capture \u00B7 AI buys too',
    ...(_lanEnabled ? ['Up to 16 players \u00B7 Coop or Vs \u00B7 Pick any tank'] : []),
  ];
  if (_modeSelIdx >= modeNames.length) _modeSelIdx = modeNames.length - 1;
  for (let i = 0; i < modeNames.length; i++) {
    const sel = i === _modeSelIdx;
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
function _onlinePreRoomHtml() {
  let html = '<div class="menu-combined">';
  html += _menuTankColsHtml();

  // Right column: online connect controls
  html += '<div class="menu-col lan-online-col">';
  html += `<div class="lan-name-row">` +
    `<input id="lan-name-input" class="lan-input lan-name-input" type="text" maxlength="16" placeholder="Player" value="${_lanPlayerName}" />` +
    `${_lanTeamSelHtml('lan-team-sel', _lanMyTeam)}` +
    `</div>`;
  html += `<div class="lan-host-row" style="margin-top:12px">` +
    `<button id="lan-host-btn" class="lan-btn">Host Game</button>` +
    `<select id="lan-max-players" class="lan-team-sel">` +
    `${[2,3,4,5,6,8,10,12,16].map(n => `<option value="${n}"${n === _lanMaxPlayers ? ' selected' : ''}>${n} players</option>`).join('')}` +
    `</select>` +
    `<select id="lan-game-type" class="lan-team-sel" style="margin-left:6px">` +
    `<option value="deathmatch"${!_ctfMode ? ' selected' : ''}>Deathmatch</option>` +
    `<option value="ctf"${_ctfMode ? ' selected' : ''}>Capture the Flag</option>` +
    `</select>` +
    `</div>`;
  html += `<div class="lan-join-row" style="margin-top:8px">` +
    `<button id="lan-scan-btn" class="lan-btn">Join A Game</button>` +
    `<input id="lan-code-input" class="lan-input lan-code-input" type="text" maxlength="4" placeholder="CODE" value="${_lanRoomCode}" />` +
    `<button id="lan-join-btn" class="lan-btn">Join</button>` +
    `</div>`;
  html += `<div id="lan-scan-results" class="lan-scan-results"></div>`;
  html += `<span id="lan-scan-status" class="lan-scan-status"></span>`;
  html += `<div class="lan-status">${_lanStatus}</div>`;
  html += `<div style="margin-top:10px">` +
    `<button id="lan-back-btn" class="lan-btn lan-btn-danger">Back to Main Menu</button>` +
    `</div>`;
  html += '</div>';

  html += '</div>';
  return html;
}

// ─── Mode selection HTML (kept for reference) ─────────────────────────────────
function modeSelectHtml() {
  const descs = [
    'Endless waves · Tank upgrades by kills · 3 lives · Solo',
    'Fixed squad of 5 · Permanent losses · Escalating enemy · Tab = switch tank',
    'Budget + purchase · Objective capture · Enemy AI buys too · Tab = switch tank',
  ];
  const names = ['Arcade', 'Attrition', 'Strategy'];
  let html = '<div class="mode-select">';
  for (let i = 0; i < 3; i++) {
    const sel = i === _modeSelIdx;
    html += `<div class="mode-opt${sel ? ' mode-selected' : ''}">`;
    html += `<div class="mode-name">${sel ? '▶ ' : ''}${names[i]}</div>`;
    html += `<div class="mode-desc">${descs[i]}</div>`;
    html += '</div>';
  }
  html += '</div>';
  return html;
}

// Combined roster for Strategy mode — all 3 main factions (no mercs)
function _strategyRoster() {
  return [
    ...FACTION_ROSTERS.american,
    ...FACTION_ROSTERS.russian,
    ...FACTION_ROSTERS.german,
  ];
}

// ─── Purchase screen HTML (Strategy) ─────────────────────────────────────────
function purchaseHtml() {
  const roster  = _strategyRoster();
  const cost    = _purchaseCost();
  const total   = _purchaseTotal();
  const remaining = _strategyBudget - cost;
  const canStart  = total > 0 && remaining >= 0;

  let html = `<div class="purchase-screen">`;

  // Objective explanation
  html += `<div class="purchase-info">` +
    `<span class="purchase-info-title">MISSION OBJECTIVE</span> ` +
    `Assemble your squad within the point budget, then fight to the battlefield. ` +
    `Locate the marked objective (yellow beacon), move your tanks inside the ring, and hold it until the capture bar fills. ` +
    `Defeat all enemies or complete the capture to advance to the next level.` +
    `</div>`;

  html += `<div class="purchase-budget">Budget: <span class="${remaining < 0 ? 'budget-over' : 'budget-ok'}">${remaining} pts remaining</span>  ·  ${total} tanks</div>`;
  html += `<div class="purchase-list">`;

  const _factionHeaderOf = key =>
    FACTION_ROSTERS.american.includes(key) ? 'ALLIES' :
    FACTION_ROSTERS.russian.includes(key)  ? 'SOVIETS' : 'AXIS';
  function bar(val, max) {
    const b = Math.min(8, Math.max(0, Math.round(val / max * 8)));
    return '█'.repeat(b) + '░'.repeat(8 - b);
  }
  let _lastHeader = null;
  for (let i = 0; i < roster.length; i++) {
    const key    = roster[i];
    const def    = CONFIG.TANK_DEFS[key];
    const n      = _purchaseSquad[key] ?? 0;
    const sel    = i === _purchaseSelIdx;
    const header = _factionHeaderOf(key);
    const canAdd = _purchaseCost() + TANK_COSTS[key] <= _strategyBudget && total < 8;
    if (header !== _lastHeader) {
      html += `<div class="purchase-faction-header">${header}</div>`;
      _lastHeader = header;
    }
    html += `<div class="purchase-row${sel ? ' purchase-selected' : ''}" data-idx="${i}">`;
    html += `<span class="pur-name">${def.name}</span>`;
    html += `<span class="pur-stats">${bar(def.frontArmour, 100)} ARM  ${bar(def.firepower, 100)} FP  ${bar(def.maxSpeed, 56)} SPD</span>`;
    html += `<span class="pur-cost">${TANK_COSTS[key]} pts</span>`;
    html += `<span class="pur-qty">` +
      `<button class="pur-adj" data-key="${key}" data-delta="-1" ${n <= 0 ? 'disabled' : ''}>◄</button>` +
      `<span class="pur-count">${n}</span>` +
      `<button class="pur-adj" data-key="${key}" data-delta="1" ${!canAdd ? 'disabled' : ''}>►</button>` +
      `</span>`;
    html += `</div>`;
  }

  html += `</div>`;
  html += `<div class="purchase-hint">Click ◄/► to adjust  ·  Enter = START BATTLE</div>`;
  if (remaining < 0) html += `<div class="purchase-error">⚠ Over budget — reduce squad</div>`;
  if (total === 0)   html += `<div class="purchase-error">⚠ Select at least one tank</div>`;
  html += `<button class="pur-start-btn" id="pur-start-btn" ${canStart ? '' : 'disabled'}>START BATTLE</button>`;
  html += `</div>`;
  return html;
}

// ─── Delegated overlay-controls listeners ────────────────────────────────────
// overlayControls.innerHTML is rebuilt every frame in several states. Using pointerdown
// rather than click: click requires mousedown+mouseup to share a common ancestor, but
// when innerHTML is rebuilt between them the mousedown target is detached from the DOM,
// so the browser finds no common ancestor and the click event is never dispatched.
if (overlayControls) {
  overlayControls.addEventListener('pointerdown', e => {
    // ── PURCHASE state ──────────────────────────────────────────────────────
    const purAdj = e.target.closest('.pur-adj');
    if (purAdj) {
      const key   = purAdj.dataset.key;
      const delta = parseInt(purAdj.dataset.delta, 10);
      const roster = _strategyRoster();
      const idx    = roster.indexOf(key);
      if (idx >= 0) _purchaseSelIdx = idx;
      if (delta > 0) {
        if (_purchaseCost() + TANK_COSTS[key] <= _strategyBudget && _purchaseTotal() < 8)
          _purchaseSquad[key] = (_purchaseSquad[key] ?? 0) + 1;
      } else {
        if ((_purchaseSquad[key] ?? 0) > 0) _purchaseSquad[key]--;
      }
      updateOverlay(); return;
    }
    const purRow = e.target.closest('.purchase-row');
    if (purRow && !e.target.closest('.pur-adj')) {
      _purchaseSelIdx = parseInt(purRow.dataset.idx, 10);
      updateOverlay(); return;
    }
    if (e.target.closest('#pur-start-btn')) {
      if (_purchaseTotal() > 0 && _purchaseCost() <= _strategyBudget) {
        startStrategyBattle(); updateOverlay();
      }
      return;
    }

    // ── MENU state ──────────────────────────────────────────────────────────
    const modeOpt = e.target.closest('.mode-opt');
    if (modeOpt) {
      _modeSelIdx = parseInt(modeOpt.dataset.modeIdx, 10);
      updateOverlay(); return;
    }
    if (e.target.closest('#menu-start-btn')) {
      _gameMode = MODE_LIST[_modeSelIdx];
      if (_gameMode === MODES.ARCADE)         startArcade();
      else if (_gameMode === MODES.ATTRITION) startAttrition();
      else if (_gameMode === MODES.STRATEGY)  startStrategyPurchase();
      else { _cleanupLan(); _lanMode = true; game.state = STATES.LAN_LOBBY; }
      updateOverlay(); return;
    }

    // ── Tank selector (MENU + LAN_LOBBY) ────────────────────────────────────
    const factionOpt = e.target.closest('.faction-opt');
    if (factionOpt) { _setFaction(factionOpt.dataset.faction); return; }
    const tsArrow = e.target.closest('.ts-arrow');
    if (tsArrow) {
      const maxIdx = _mercsEnabled ? ALL_TANKS.length - 1 : 11;
      if (tsArrow.dataset.dir === 'left' && _selIdx > 0) {
        _selIdx--;
        _faction = _factionFromIdx(_selIdx);
        PLAYER_TANKS = FACTION_ROSTERS[_faction];
        _buildPreview(ALL_TANKS[_selIdx]); updateOverlay();
      } else if (tsArrow.dataset.dir === 'right' && _selIdx < maxIdx) {
        _selIdx++;
        _faction = _factionFromIdx(_selIdx);
        PLAYER_TANKS = FACTION_ROSTERS[_faction];
        _buildPreview(ALL_TANKS[_selIdx]); updateOverlay();
      }
      return;
    }
    const mercAdj = e.target.closest('.merc-adj');
    if (mercAdj) {
      const stat  = mercAdj.dataset.stat;
      const delta = parseFloat(mercAdj.dataset.delta);
      const cs    = _getMercObliteratorStats();
      cs[stat] = Math.round((cs[stat] + delta) * 10) / 10;
      if (stat === 'reloadTime')  cs[stat] = Math.max(0.5, Math.min(6.0, cs[stat]));
      else if (stat === 'maxSpeed') cs[stat] = Math.max(5, Math.min(100, cs[stat]));
      else cs[stat] = Math.max(5, Math.min(100, cs[stat]));
      _saveObliteratorStats(); updateOverlay(); return;
    }
    if (e.target.closest('#merc-edit-btn')) { _mercEditorOpen = true; updateOverlay(); return; }

    // ── Merc editor ─────────────────────────────────────────────────────────
    const meAdj = e.target.closest('.me-adj');
    if (meAdj) {
      const cs    = _getMercObliteratorStats();
      const stat  = meAdj.dataset.stat;
      const delta = parseFloat(meAdj.dataset.delta);
      const min   = parseFloat(meAdj.dataset.min);
      const max   = parseFloat(meAdj.dataset.max);
      cs[stat] = Math.round((cs[stat] + delta) * 100) / 100;
      cs[stat] = Math.max(min, Math.min(max, cs[stat]));
      const disp = Number.isInteger(cs[stat]) ? cs[stat] : cs[stat].toFixed(Math.abs(delta) < 0.1 ? 2 : 1);
      const unit = stat === 'maxSpeed' || stat === 'xcSpeed' ? ' km/h' : '';
      const el = document.getElementById(`mev-${stat}`);
      if (el) el.textContent = disp + unit;
      _saveObliteratorStats(); return;
    }
    const meVis = e.target.closest('.me-vis');
    if (meVis) {
      const cs    = _getMercObliteratorStats();
      const prop  = meVis.dataset.prop;
      const delta = parseFloat(meVis.dataset.delta);
      const min   = parseFloat(meVis.dataset.min);
      const max   = parseFloat(meVis.dataset.max);
      cs[prop] = Math.round((cs[prop] + delta) * 100) / 100;
      cs[prop] = Math.max(min, Math.min(max, cs[prop]));
      const el = document.getElementById(`mev-${prop}`);
      if (el) el.textContent = cs[prop].toFixed(2);
      _saveObliteratorStats(); _buildPreview('obliterator'); return;
    }
    if (e.target.closest('#me-reset-btn')) {
      const cs = _getMercObliteratorStats();
      Object.assign(cs, _obliteratorDefaults());
      _saveObliteratorStats(); _buildPreview('obliterator');
      _mercEditorOpen = true; updateOverlay(); return;
    }
    if (e.target.closest('#me-close-btn') || e.target.closest('#me-done-btn')) {
      _mercEditorOpen = false; updateOverlay(); return;
    }

    // ── LAN lobby buttons ────────────────────────────────────────────────────
    if (e.target.closest('#lan-host-btn'))  { startLanHost(); return; }
    if (e.target.closest('#lan-start-btn')) { startLanGameAsHost(); return; }
    if (e.target.closest('#lan-join-btn')) {
      const code = overlayControls.querySelector('#lan-code-input')?.value.trim() || '';
      if (!code) { _lanStatus = 'Enter the 4-character room code.'; updateOverlay(); return; }
      startLanClient(code); return;
    }
    if (e.target.closest('#lan-back-btn')) {
      _cleanupLan(); game.state = STATES.MENU; updateOverlay(); return;
    }
    if (e.target.closest('#lan-scan-btn')) {
      (async () => {
        const btn         = overlayControls.querySelector('#lan-scan-btn');
        const scanStatus  = overlayControls.querySelector('#lan-scan-status');
        const scanResults = overlayControls.querySelector('#lan-scan-results');
        if (btn) btn.disabled = true;
        if (scanStatus)  scanStatus.textContent = 'Looking\u2026';
        if (scanResults) scanResults.innerHTML  = '';
        try {
          const r    = await fetch(_discoverUrl);
          const data = await r.json();
          const waitingRooms = (data.rooms || []);
          if (btn) btn.disabled = false;
          if (waitingRooms.length === 0) {
            if (scanStatus) scanStatus.textContent = 'No games waiting.';
          } else {
            if (scanStatus) scanStatus.textContent =
              `${waitingRooms.length} game${waitingRooms.length > 1 ? 's' : ''} waiting:`;
            if (scanResults) {
              scanResults.innerHTML = waitingRooms.map(g =>
                `<button class="lan-scan-result lan-scan-result-ready" data-code="${g.code}">` +
                `<span class="scan-code">${g.code}</span>` +
                `<span class="scan-info">${g.players}/${g.max}</span>` +
                `</button>`
              ).join('');
            }
          }
        } catch {
          if (btn) btn.disabled = false;
          if (scanStatus) scanStatus.textContent = 'Relay server not reachable.';
        }
      })();
      return;
    }
    const scanResult = e.target.closest('.lan-scan-result');
    if (scanResult) { startLanClient(scanResult.dataset.code); return; }
  });

  // Delegated change listener (select elements inside overlay)
  overlayControls.addEventListener('change', e => {
    if (e.target.id === 'lan-team-sel-room') {
      _lanMyTeam = parseInt(e.target.value) || 0;
      if (_lanNet?.id) _lanRoster.set(_lanNet.id, { name: _lanPlayerName, team: _lanMyTeam, tankKey: _lanTankKey });
      if (_lanNet) {
        _lanNet.sendHello(_lanTankKey, _lanPlayerName, _lanMyTeam);
        if (_lanNet.isHost()) _lanNet.sendRoster(_lanRoster);
      }
      updateOverlay();
    }
  });

  // Delegated input listener (text inputs inside overlay)
  overlayControls.addEventListener('input', e => {
    if (e.target.id === 'me-name-input') {
      const cs = _getMercObliteratorStats();
      cs.customName = e.target.value.trim();
      _saveObliteratorStats();
    }
  });
}

// ─── Overlay updater ─────────────────────────────────────────────────────────
function updateOverlay() {
  const s = game.state;

  // Hold GAME_OVER screen until death camera has finished
  if (s === STATES.GAME_OVER && _deathCamTimer >= 0) return;

  if (s === STATES.PLAYING) {
    overlay.className = 'overlay-hidden';
    return;
  }

  overlay.className = 'overlay-visible';

  // ── Merc editor takes full control of the overlay ──────────────────────────
  if (_mercEditorOpen && (s === STATES.MENU || s === STATES.LAN_LOBBY)) {
    overlayTitle.textContent = '';
    overlaySub.textContent   = '';
    overlayScore.textContent = '';
    overlayHint.textContent  = '';
    if (overlayControls) {
      overlayControls.innerHTML = _mercEditorHtml();
      _wireMercEditor(overlayControls);
    }
    if (_prevCanvas) {
      _prevCanvas.style.display = 'block';
      _prevCanvas.className = `faction-${_faction}`;
    }
    return;
  }

  if (s === STATES.LAN_LOBBY) {
    overlayTitle.textContent = 'ONLINE';
    overlaySub.textContent   = 'Crush your opponent';
    overlayScore.textContent = '';
    overlayHint.textContent  = '';
    if (overlayControls) {
      overlayControls.innerHTML = lanLobbyHtml();
      const inRoom = !!_lanRoomCode && _lanMode;
      const menuWarnEl = document.getElementById('menu-warn');
      if (!inRoom) {
        if (menuWarnEl) {
          const lines = ['\u26A0  Online play is in beta and has not been well tested, especially at high player counts'];
          if (_faction === 'mercenary') lines.push('\u26A0  Mercenaries are experimental and not balanced for gameplay');
          menuWarnEl.innerHTML = lines.join('<br>');
          menuWarnEl.style.display = 'block';
        }
        if (_prevCanvas) _prevCanvas.className = `faction-${_faction}`;
      } else {
        if (menuWarnEl) menuWarnEl.style.display = 'none';
      }
    }
    return;
  }

  if (s === STATES.PURCHASE) {
    overlayTitle.textContent = 'PURCHASE SQUAD';
    overlaySub.textContent   = `Level ${_strategyLevel + 1}  ·  Budget: ${_strategyBudget} pts`;
    overlayScore.textContent = '';
    overlayHint.textContent  = '';
    if (overlayControls) {
      overlayControls.innerHTML = purchaseHtml();
    }
    return;
  }

  if (s === STATES.MENU) {
    overlayTitle.textContent = 'TREADS OF WAR';
    overlaySub.textContent   = 'Select vehicle and battle mode';
    if (overlayControls) {
      overlayControls.innerHTML = menuScreenHtml();
    }
    overlayScore.textContent = '';
    overlayHint.textContent  = '\u25C4 / \u25BA  Vehicle   \u00B7   \u25B2 / \u25BC  Mode   \u00B7   Enter  Start';
    const menuWarnEl = document.getElementById('menu-warn');
    if (menuWarnEl) {
      if (_faction === 'mercenary') {
        menuWarnEl.textContent = '\u26A0  Mercenaries are experimental and not balanced for gameplay';
        menuWarnEl.style.display = 'block';
      } else {
        menuWarnEl.style.display = 'none';
      }
    }
    if (_prevCanvas) _prevCanvas.className = `faction-${_faction}`;
    return;
  }

  // Hide menu warning when not on menu screen
  const _mwEl = document.getElementById('menu-warn');
  if (_mwEl) _mwEl.style.display = 'none';

  if (overlayControls) overlayControls.innerHTML = '';

  if (s === STATES.PAUSED) {
    overlayTitle.textContent = 'PAUSED';
    overlaySub.textContent   = '';
    overlayScore.textContent = `Score: ${game.score}  ·  Kills: ${game.kills}`;
    overlayHint.textContent  = 'Press P to resume';

  } else if (s === STATES.WAVE_COMPLETE) {
    overlayTitle.textContent = `WAVE ${game.wave} CLEARED`;
    overlaySub.textContent   = `Prepare for wave ${game.wave + 1} of ${game.totalWaves}`;
    overlayScore.textContent = `Score: ${game.score}  ·  +${DIFFICULTY.waveRepairHp} HP repair`;
    overlayHint.textContent  = 'Press R to continue';

  } else if (s === STATES.BATTLE_COMPLETE) {
    const modeLabel = _gameMode === MODES.ATTRITION ? 'Battle' : 'Objective';
    overlayTitle.textContent = `${modeLabel.toUpperCase()} WON`;
    if (_gameMode === MODES.ATTRITION) {
      const survivors = _playerSquad.filter(t => t.alive).length;
      overlaySub.textContent = `Battle ${_attritionBattle + 1} cleared  ·  ${survivors} / ${_playerSquad.length} tanks surviving`;
    } else {
      overlaySub.textContent = `Level ${_strategyLevel + 1} cleared  ·  Next budget: ${STRATEGY_BUDGETS[Math.min(_strategyLevel + 1, STRATEGY_BUDGETS.length - 1)]} pts`;
    }
    overlayScore.textContent = `Score: ${game.score}  ·  Kills: ${game.kills}`;
    overlayHint.textContent  = 'Press R to continue';

  } else if (s === STATES.GAME_OVER) {
    if (_lanMode) {
      overlayTitle.textContent = 'DEFEATED';
      overlaySub.textContent   = 'Your tank was destroyed';
      overlayScore.textContent = '';
      overlayHint.textContent  = '';
    } else if (_gameMode === MODES.ARCADE) {
      overlayTitle.textContent = 'TANK DESTROYED';
      overlaySub.textContent   = `Class ${_arcadeClass + 1}  ·  Kills: ${game.kills}`;
      overlayScore.textContent = `Final score: ${game.score}  ·  Total kills: ${game.kills}`;
    } else {
      overlayTitle.textContent = 'SQUAD DESTROYED';
      overlaySub.textContent   = _gameMode === MODES.ATTRITION
        ? `Battle ${_attritionBattle + 1}  ·  Squad wiped out`
        : `Level ${_strategyLevel + 1}  ·  Squad wiped out`;
      overlayScore.textContent = `Final score: ${game.score}  ·  Total kills: ${game.kills}`;
    }
    overlayHint.textContent = _lanMode ? '' : 'Press R to return to menu';
    if (_lanMode && overlayControls) {
      overlayControls.innerHTML = _lanEndScreenHtml(false);
      _wireLanEndButtons();
    }

  } else if (s === STATES.VICTORY) {
    if (_lanMode) {
      overlayTitle.textContent = 'VICTORY';
      overlaySub.textContent   = '';
      overlayScore.textContent = '';
      overlayHint.textContent  = '';
      if (overlayControls) {
        overlayControls.innerHTML = _lanEndScreenHtml(true);
        _wireLanEndButtons();
      }
    } else {
      overlayTitle.textContent = 'MISSION COMPLETE';
      overlaySub.textContent   = 'All three waves cleared';
      overlayScore.textContent = `Final score: ${game.score}`;
      overlayHint.textContent  = 'Press R to play again';
    }
  }
}

function _lanEndScreenHtml(won) {
  return `
    <div class="lan-lobby">
      ${won ? '' : `<div class="lan-status" style="font-size:13px;color:rgba(255,100,80,0.85)">● Your tank was destroyed</div>`}
      <div style="display:flex;gap:10px;margin-top:8px;">
        <button id="lan-menu-btn" class="lan-btn">Main Menu</button>
        <button id="lan-lobby-btn" class="lan-btn">Online Lobby</button>
      </div>
    </div>`;
}

function _wireLanEndButtons() {
  const menu = overlayControls.querySelector('#lan-menu-btn');
  if (menu) menu.addEventListener('click', () => {
    _cleanupLan();
    game.state = STATES.MENU;
    updateOverlay();
  });
  const lobby = overlayControls.querySelector('#lan-lobby-btn');
  if (lobby) lobby.addEventListener('click', () => {
    _cleanupLan();
    _lanMode = true;
    game.state = STATES.LAN_LOBBY;
    updateOverlay();
  });
}

// ─── Keyboard handlers for overlay actions ────────────────────────────────────
window.addEventListener('keydown', e => {
  audio.resume();   // unlock AudioContext on any key press (browser autoplay policy)

  // ── Purchase screen (Strategy) ────────────────────────────────────────────
  if (game.state === STATES.PURCHASE) {
    const roster  = _strategyRoster();
    if (e.code === 'ArrowUp') {
      _purchaseSelIdx = Math.max(0, _purchaseSelIdx - 1);
      updateOverlay();
    } else if (e.code === 'ArrowDown') {
      _purchaseSelIdx = Math.min(roster.length - 1, _purchaseSelIdx + 1);
      updateOverlay();
    } else if (e.code === 'ArrowRight') {
      const key  = roster[_purchaseSelIdx];
      const cost = TANK_COSTS[key];
      if (_purchaseCost() + cost <= _strategyBudget && _purchaseTotal() < 8) {
        _purchaseSquad[key] = (_purchaseSquad[key] ?? 0) + 1;
        updateOverlay();
      }
    } else if (e.code === 'ArrowLeft') {
      const key = roster[_purchaseSelIdx];
      if ((_purchaseSquad[key] ?? 0) > 0) {
        _purchaseSquad[key]--;
        updateOverlay();
      }
    } else if (e.code === 'Enter' || e.code === 'Space') {
      if (_purchaseTotal() > 0 && _purchaseCost() <= _strategyBudget) {
        startStrategyBattle();
        updateOverlay();
      }
    } else if (e.code === 'Escape') {
      // Back to menu
      game.state = STATES.MENU;
      updateOverlay();
    }
    return;
  }

  // ── Main menu — Left/Right = tank, Up/Down = mode, Enter = start ──────────
  if (game.state === STATES.MENU) {
    if (e.code === 'ArrowLeft') {
      _selIdx = Math.max(0, _selIdx - 1);
      _faction = _factionFromIdx(_selIdx);
      PLAYER_TANKS = FACTION_ROSTERS[_faction];
      _buildPreview(ALL_TANKS[_selIdx]);
      updateOverlay();
    } else if (e.code === 'ArrowRight') {
      const _maxIdx = _mercsEnabled ? ALL_TANKS.length - 1 : 11;
      _selIdx = Math.min(_maxIdx, _selIdx + 1);
      _faction = _factionFromIdx(_selIdx);
      PLAYER_TANKS = FACTION_ROSTERS[_faction];
      _buildPreview(ALL_TANKS[_selIdx]);
      updateOverlay();
    } else if (e.code === 'ArrowUp') {
      _modeSelIdx = Math.max(0, _modeSelIdx - 1);
      updateOverlay();
    } else if (e.code === 'ArrowDown') {
      _modeSelIdx = Math.min((_lanEnabled ? MODE_LIST.length : MODE_LIST.length - 1) - 1, _modeSelIdx + 1);
      updateOverlay();
    } else if (e.code === 'Enter' || e.code === 'Space') {
      _gameMode = MODE_LIST[_modeSelIdx];
      if (_gameMode === MODES.ARCADE)         startArcade();
      else if (_gameMode === MODES.ATTRITION) startAttrition();
      else if (_gameMode === MODES.STRATEGY)  startStrategyPurchase();
      else {
        // LAN Duel — go to lobby
        game.state = STATES.LAN_LOBBY;
      }
      updateOverlay();
    }
    return;
  }

  // ── Between-wave / between-battle ─────────────────────────────────────────
  if (game.state === STATES.WAVE_COMPLETE) {
    if (e.code === 'KeyR' && _gameMode === MODES.ARCADE) {
      // Partial HP repair between waves (amount scales with difficulty)
      player.hp = Math.min(player.maxHp, player.hp + DIFFICULTY.waveRepairHp);
      _prevHpTier = player.hp < 12 ? 3 : player.hp < 25 ? 2 : player.hp < 50 ? 1 : 0;
      if (_damageSmoke && player.hp >= 50) { _damageSmoke.active = false; _damageSmoke = null; }
      clearCraters(); _resetSmoke(); _resetArtillery(); _resetSpotter();
      game.advanceWave();
      spawnArcadeWave();
      updateOverlay();
    }
    return;
  }

  if (game.state === STATES.BATTLE_COMPLETE) {
    if (e.code === 'KeyR') {
      if (_gameMode === MODES.ATTRITION) advanceAttritionBattle();
      else advanceStrategyBattle();
    }
    return;
  }

  if (game.state === STATES.GAME_OVER || game.state === STATES.VICTORY) {
    if (e.code === 'KeyR') window.location.reload();
    return;
  }

  // ── Arcade upgrade on keypress ────────────────────────────────────────────
  if (game.state === STATES.PLAYING && _gameMode === MODES.ARCADE) {
    if (e.code === 'KeyU') _doArcadeUpgrade();
  }
});

// Show the menu overlay immediately + build initial tank preview
_buildPreview(ALL_TANKS[_selIdx]);
updateOverlay();

// ─── Minimap ──────────────────────────────────────────────────────────────────
const _mmCanvas = document.getElementById('minimap');
const _mmCtx    = _mmCanvas && _mmCanvas.getContext('2d');
const MM_SIZE   = 210;
const MM_PAD    = 10;
const MM_INNER  = MM_SIZE - MM_PAD * 2;

function updateMinimap() {
  if (!_mmCtx) return;
  const ctx   = _mmCtx;
  const M     = CONFIG.MAP_HALF;
  const scale = MM_INNER / (M * 2);   // pixels per world unit

  ctx.clearRect(0, 0, MM_SIZE, MM_SIZE);
  ctx.fillStyle = 'rgba(10, 18, 12, 0.84)';
  ctx.fillRect(0, 0, MM_SIZE, MM_SIZE);

  // North-up: world X → canvas X (east = right), world Z → canvas Y (south = down)
  function toMM(wx, wz) {
    return {
      x: MM_PAD + (wx + M) / (M * 2) * MM_INNER,
      y: MM_PAD + (wz + M) / (M * 2) * MM_INNER,
    };
  }

  // Map boundary
  ctx.strokeStyle = 'rgba(70, 120, 70, 0.42)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(MM_PAD, MM_PAD, MM_INNER, MM_INNER);

  // Roads
  ctx.strokeStyle = 'rgba(130, 105, 70, 0.55)';
  ctx.lineWidth   = 2;
  for (const spline of _roadSplines) {
    ctx.beginPath();
    const p0 = toMM(spline[0].x, spline[0].z);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < spline.length; i++) {
      const p = toMM(spline[i].x, spline[i].z);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  // Water (rivers + ponds) — drawn after roads so water shows over road colour
  ctx.fillStyle = 'rgba(40, 105, 195, 0.60)';
  const mmWaterSz = Math.max(2.5, WATER_CELL * scale);
  for (const key of _waterGrid.keys()) {
    const comma = key.indexOf(',');
    const cx = parseInt(key.slice(0, comma), 10);
    const cz = parseInt(key.slice(comma + 1), 10);
    const p  = toMM((cx + 0.5) * WATER_CELL, (cz + 0.5) * WATER_CELL);
    ctx.fillRect(p.x - mmWaterSz * 0.5, p.y - mmWaterSz * 0.5, mmWaterSz, mmWaterSz);
  }

  // Smoke clouds
  for (const c of _smokeClouds) {
    const elapsed    = c.maxLife - c.life;
    const expandFrac = Math.min(1, elapsed / SMOKE_EXPAND);
    const fadeAlpha  = c.life < SMOKE_FADE ? c.life / SMOKE_FADE : 1.0;
    const p = toMM(c.x, c.z);
    const r = Math.max(2, SMOKE_PUFF_R * expandFrac * scale);
    ctx.globalAlpha = 0.38 * fadeAlpha;
    ctx.fillStyle = '#c0c0c0';
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1.0;
  }

  // Destroyed enemy wrecks
  ctx.fillStyle = 'rgba(90, 55, 35, 0.62)';
  for (const e of enemies) {
    if (e.alive) continue;
    const p = toMM(e.position.x, e.position.z);
    ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
  }

  // Alive enemies — hidden in Strategy mode until a spotter plane is called
  if (_gameMode !== MODES.STRATEGY || _spotterTimer > 0) {
    ctx.fillStyle = 'rgba(210, 60, 35, 0.90)';
    for (const e of enemies) {
      if (!e.alive) continue;
      const p = toMM(e.position.x, e.position.z);
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Wingmen — cyan dots
  ctx.fillStyle = 'rgba(60, 210, 255, 0.90)';
  for (const w of wingmen) {
    if (!w.alive) continue;
    const p = toMM(w.position.x, w.position.z);
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
  }

  // Recoverable wrecks — hollow cyan circles
  ctx.strokeStyle = 'rgba(60, 210, 255, 0.70)';
  ctx.lineWidth   = 1.5;
  for (const wr of _wrecks) {
    const p = toMM(wr.tank.position.x, wr.tank.position.z);
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.stroke();
  }

  // Supply crates — neutral grey diamonds (distinct shape + colour from enemy circles)
  ctx.fillStyle = 'rgba(210, 205, 170, 0.90)';
  for (const c of _crates) {
    if (!c.alive) continue;
    const p = toMM(c.x, c.z);
    ctx.beginPath();
    ctx.moveTo(p.x,     p.y - 4);
    ctx.lineTo(p.x + 4, p.y    );
    ctx.lineTo(p.x,     p.y + 4);
    ctx.lineTo(p.x - 4, p.y    );
    ctx.closePath();
    ctx.fill();
  }

  // Objective marker (Strategy mode) — drawn before player dot so dot is always on top
  if (_gameMode === MODES.STRATEGY && _objectivePos) {
    const op    = toMM(_objectivePos.x, _objectivePos.z);
    const phase = _objectivePhase;
    // Pulsing outer halo
    const haloR = 10 + 3 * Math.sin(phase * Math.PI * 2);
    ctx.globalAlpha = 0.28 + 0.12 * Math.sin(phase * Math.PI * 2);
    ctx.strokeStyle = '#FFFF44';
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.arc(op.x, op.y, haloR, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1.0;
    // Solid inner circle
    ctx.fillStyle = '#FFFF44';
    ctx.beginPath(); ctx.arc(op.x, op.y, 5, 0, Math.PI * 2); ctx.fill();
    // Cross arms
    ctx.strokeStyle = '#FFFF44';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(op.x - 9, op.y); ctx.lineTo(op.x + 9, op.y);
    ctx.moveTo(op.x, op.y - 9); ctx.lineTo(op.x, op.y + 9);
    ctx.stroke();
    // "OBJ" label
    ctx.fillStyle = 'rgba(255, 255, 80, 0.90)';
    ctx.font      = '9px Courier New, monospace';
    ctx.fillText('OBJ', op.x + 7, op.y - 7);
  }

  // Player position on the fixed map
  const pp = toMM(player.position.x, player.position.z);

  // FOV V — rotates with the player heading, drawn at the player's map position.
  // In north-up canvas: heading=0 → player faces -Z = "up" (canvas angle -π/2).
  // canvas angle for heading h = atan2(-cos(h), -sin(h)) = -(π/2 + h)
  const FOV_HALF   = Math.PI / 6;   // ±30° (60° camera FOV)
  const FOV_PX     = 57;            // arm length in pixels (scaled 1.5× with minimap)
  const fovAngle   = -(Math.PI / 2 + player.heading);
  ctx.fillStyle    = 'rgba(75, 215, 95, 0.07)';
  ctx.strokeStyle  = 'rgba(75, 215, 95, 0.30)';
  ctx.lineWidth    = 1;
  ctx.beginPath();
  ctx.moveTo(pp.x, pp.y);
  ctx.arc(pp.x, pp.y, FOV_PX, fovAngle - FOV_HALF, fovAngle + FOV_HALF);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // LAN peer tanks — coloured by team
  if (_lanMode && _lanGameActive) {
    for (const [, peer] of _lanPeers) {
      if (!peer.tank) continue;
      const tc = LAN_TEAM_COLORS[peer.team] ?? LAN_TEAM_COLORS[0];
      const r = (tc >> 16) & 0xFF, g = (tc >> 8) & 0xFF, b = tc & 0xFF;
      ctx.fillStyle = peer.tank.alive
        ? `rgba(${r},${g},${b},0.90)` : 'rgba(90,55,35,0.62)';
      const pp2 = toMM(peer.tank.position.x, peer.tank.position.z);
      ctx.beginPath(); ctx.arc(pp2.x, pp2.y, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Player dot (drawn on top of the FOV V) — team colour in LAN mode
  if (_lanMode && player.alive) {
    const tc = LAN_TEAM_COLORS[_lanMyTeam] ?? LAN_TEAM_COLORS[0];
    const r = (tc >> 16) & 0xFF, g = (tc >> 8) & 0xFF, b = tc & 0xFF;
    ctx.fillStyle = `rgba(${r},${g},${b},0.95)`;
  } else {
    ctx.fillStyle = player.alive ? 'rgba(75, 215, 95, 0.95)' : 'rgba(190, 185, 100, 0.65)';
  }
  ctx.beginPath(); ctx.arc(pp.x, pp.y, 5, 0, Math.PI * 2); ctx.fill();

  // CTF flag icons (LAN CTF mode only)
  if (_ctfMode && _lanMode && _ctf.isActive()) {
    for (let t = 0; t < 2; t++) {
      const col = FLAG_COLORS[t];
      const cr = (col >> 16) & 0xFF, cg = (col >> 8) & 0xFF, cb = col & 0xFF;
      const baseCol = `rgba(${cr},${cg},${cb},0.85)`;

      // Base marker — hollow pentagon-star outline at base position
      const base = _ctf.getBasePos(t);
      const bp = toMM(base.x, base.z);
      ctx.strokeStyle = baseCol;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const outerA = (i * 2 * Math.PI / 5) - Math.PI / 2;
        const innerA = outerA + Math.PI / 5;
        if (i === 0) ctx.moveTo(bp.x + 6 * Math.cos(outerA), bp.y + 6 * Math.sin(outerA));
        else          ctx.lineTo(bp.x + 6 * Math.cos(outerA), bp.y + 6 * Math.sin(outerA));
        ctx.lineTo(bp.x + 2.5 * Math.cos(innerA), bp.y + 2.5 * Math.sin(innerA));
      }
      ctx.closePath();
      ctx.stroke();

      // Flag current position indicator
      const status = _ctf.getFlagStatus(t);
      if (status === 'carried') {
        // Show flag dot above the carrier's tank dot
        const carrierId  = _ctf.getFlagCarrierId(t);
        let carrierPos   = null;
        if (carrierId === _lanNet?.id) {
          carrierPos = player.position;
        } else {
          const peer = _lanPeers.get(carrierId);
          if (peer?.tank) carrierPos = peer.tank.position;
        }
        if (carrierPos) {
          const cp = toMM(carrierPos.x, carrierPos.z);
          ctx.fillStyle = `rgba(${cr},${cg},${cb},0.95)`;
          ctx.beginPath(); ctx.arc(cp.x, cp.y - 7, 3, 0, Math.PI * 2); ctx.fill();
        }
      } else if (status === 'dropped') {
        // Pulsing dot at drop position
        const dp  = _ctf.getFlagDropPos(t);
        const dmp = toMM(dp.x, dp.z);
        const pulse = 0.55 + 0.45 * Math.sin(performance.now() * 0.004);
        ctx.globalAlpha = pulse;
        ctx.fillStyle = `rgba(${cr},${cg},${cb},0.90)`;
        ctx.beginPath(); ctx.arc(dmp.x, dmp.y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1.0;
      }
    }
  }

  // MAP label
  ctx.fillStyle = 'rgba(90, 150, 90, 0.36)';
  ctx.font      = '11px Courier New, monospace';
  ctx.fillText('MAP', MM_PAD + 2, MM_PAD + 9);
}

let fpsCount = 0, fpsTime = performance.now();
let prevPauseKey = false;

// ─── Artillery support ────────────────────────────────────────────────────────
// Player calls in off-map artillery. Shells land after ARTY_DELAY seconds
// spread around the ballistic aim point. Any tank in a shell's blast radius
// takes falloff damage — including the player if they stay in the zone.
let _artilleryCharges = ARTY_CHARGES;
const _artilleryQueue = [];   // pending impacts: { x, z, timer }

// ─── Spotter plane (Strategy only) ───────────────────────────────────────────
let _spotterCharges = SPOTTER_CHARGES;
let _spotterTimer   = 0;   // counts down; enemy dots visible on minimap while > 0

// ─── Tank recovery (Attrition/Strategy only) ──────────────────────────────────
let _wrecks          = [];   // { tank, smoker, labelEl } — recoverable friendly wrecks
let _recoveringWreck = null; // wreck currently being recovered
let _recoveryTimer   = 0;    // seconds elapsed toward WRECK_RECOVER_T
let _recoveryHp      = 0;    // player HP when recovery started (for interrupt check)
const _tempProjVec   = new THREE.Vector3(); // reused for 3D→screen projection

// ─── Ammo type ────────────────────────────────────────────────────────────────
// Tab key cycles between AP (armour-piercing) and HE (high-explosive).
// HE bypasses armour on direct hits and deals area-of-effect splash damage.
let _ammoType = 'AP';

// ─── Death camera state ───────────────────────────────────────────────────────
let _killer          = null;   // enemy Tank that killed the player
let _deathCamTimer   = -1;     // -1 = inactive; >= 0 = seconds elapsed
let _waveEndTimer    = -1;     // seconds remaining before next arcade wave spawns (-1 = not pending)
let _deathCamAngle   = 0;      // current orbit angle (radians)
let _lives           = 3;      // player lives remaining (shown as ♦♦♦)
let _pendingRespawn  = false;  // true while death cam is playing and respawn is queued

// ─── Damage smoke state ───────────────────────────────────────────────────────
let _damageSmoke  = null;    // Smoker instance or null (player only)
let _prevHpTier   = 0;       // 0=healthy, 1=half-speed, 2=quarter-speed
// Per-NPC damage smokers: Map<Tank, { smoker: Smoker|null, tier: number }>
const _npcSmokers = new Map();

// ─── Camera shake state ───────────────────────────────────────────────────────
let _shakeMag = 0;

function addShake(mag) {
  _shakeMag = Math.min(10, _shakeMag + mag);
}

// ─── Tank death handler ───────────────────────────────────────────────────────
// Called whenever a tank is killed. overkill = damage above the tank's remaining HP.
// When overkill is low and the tank is a friendly in a squad mode, creates a
// recoverable wreck instead of a fully charred catastrophic kill.
function _processTankDeath(tank, killer, overkill = 0) {
  tank.setDestroyed();

  const isSquadMode = _gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY;
  const isFriendly  = wingmen.includes(tank) || tank === player;
  const isRecoverable = isSquadMode && isFriendly && !tank._noRescue
    && overkill < tank.maxHp * WRECK_OVERKILL_PCT;

  if (isRecoverable) {
    // Damaged but salvageable — darken to a bruised dark grey-brown (not charred black)
    tank.mesh.traverse(obj => {
      if (obj.isMesh && obj.material && obj.material.color && obj.material.vertexColors) {
        obj.material.color.setHex(0x2A2820);
      }
    });
    const s = tank.def.modelScale;
    const smoker = particles.addWreckSmoker(
      tank.position.x, tank.position.y + 1.0 * s, tank.position.z
    );

    // Floating "RECOVERABLE" label
    const labelEl = document.createElement('div');
    Object.assign(labelEl.style, {
      position: 'absolute', color: 'rgba(220,50,50,0.95)',
      font: 'bold 18px "Courier New",monospace',
      pointerEvents: 'none', display: 'none', textAlign: 'center',
      textShadow: '0 0 5px rgba(0,0,0,0.95)', transform: 'translateX(-50%)',
    });
    labelEl.textContent = '▲ RECOVERABLE';
    document.getElementById('hud').appendChild(labelEl);

    // Recovery zone ring — flat red circle on the ground at WRECK_RECOVER_R radius
    const _rGeo = new THREE.RingGeometry(WRECK_RECOVER_R - 0.45, WRECK_RECOVER_R, 40);
    _rGeo.rotateX(-Math.PI / 2);
    const _rMat = new THREE.MeshBasicMaterial({
      color: 0xFF2020, transparent: true, opacity: 0.60,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const ringMesh = new THREE.Mesh(_rGeo, _rMat);
    ringMesh.position.set(tank.position.x, tank.position.y + 0.25, tank.position.z);
    ringMesh.renderOrder = 1;
    scene.add(ringMesh);

    _wrecks.push({ tank, smoker, labelEl, ringMesh });
  } else {
    // Catastrophic kill — char hull to blackened wreck
    tank.mesh.traverse(obj => {
      if (obj.isMesh && obj.material && obj.material.color && obj.material.vertexColors) {
        obj.material.color.setHex(0x1A1208);
      }
    });
    const s = tank.def.modelScale;
    particles.addBurner(tank.position.x, tank.position.y + 1.1 * s, tank.position.z);
  }

  // Burn scar under destroyed hull — black centre shading to medium brown
  addDeathCrater(tank.position.x, tank.position.z);
  // Freeze last 5 tank-lengths of tracks for dramatic effect
  const trail = _tankTrails.get(tank);
  if (trail) trail.freezeLastForDrama(tank.def.modelScale * 8);
  if (tank === player) {
    _exitSightMode();
    _killer = killer ?? null;
    _deathCamAngle = _killer
      ? Math.atan2(
          _killer.position.x - player.position.x,
          _killer.position.z - player.position.z,
        ) + Math.PI
      : 0;

    if (_lanMode) {
      // Online mode: no lives — immediately show defeat
      if (_damageSmoke) { _damageSmoke.active = false; _damageSmoke = null; }
      _endLanGame(false);
    } else if (_gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY) {
      // Squad mode: auto-switch to next alive squad tank, no lives/respawn
      _deathCamTimer = 1.5;  // brief death cam then auto-switch
      if (_damageSmoke) { _damageSmoke.active = false; _damageSmoke = null; }
      _showSquadHUD();
    } else {
      // Arcade mode: use lives system
      _deathCamTimer = 0;
      if (_damageSmoke) { _damageSmoke.active = false; _damageSmoke = null; }
      if (_lives > 0) {
        _lives--;
        _pendingRespawn = true;
        if (hudLives) hudLives.textContent = '♦'.repeat(_lives);
        _drawLivesIcons();
      } else {
        // Final life — mark all icons as lost before game over shows
        _lives = -1;
        _drawLivesIcons();
      }
    }
  }
}

// ─── Player respawn (called after death-cam when lives remain) ─────────────────
function _respawnPlayer() {
  const spawnX = (Math.random() - 0.5) * 60;
  const spawnZ = (Math.random() - 0.5) * 60;
  player.alive      = true;
  player.hp         = 60;
  player.leftSpeed  = 0;
  player.rightSpeed = 0;
  player.reloadTimer = player.reloadTime;
  player.position.set(spawnX, getAltitude(spawnX, spawnZ) + 0.5, spawnZ);
  player.mesh.position.copy(player.position);
  player._camInit = false;
  _deathCamTimer  = -1;
  _prevHpTier     = 0;
  // Restore hull: clear charring tint (vertex-coloured meshes only; skip shared gun barrel material)
  player.mesh.traverse(obj => {
    if (obj.isMesh && obj.material && obj.material.color && obj.material.vertexColors) {
      obj.material.color.setHex(0xFFFFFF);
    }
  });
  player.turretGroup.visible = true;
  player.mesh.rotation.set(0, player.mesh.rotation.y, 0);  // clear death lean
  if (hudHp)  hudHp.textContent = 'HP 60%';
  if (hudHitIndicator) {
    hudHitIndicator.textContent = `★  CREW ALIVE  ·  ${_lives} LIVES REMAINING`;
    hudHitIndicator.style.color = 'rgba(120, 200, 255, 0.95)';
    hudHitIndicator.style.opacity = '1';
    _hitIndTimer = 3.5;
  }
}

// ─── Smoke grenades ───────────────────────────────────────────────────────────
// In-flight canisters and deployed clouds. Clouds suppress enemy fire while
// the player is inside them. 3 grenades per wave, replenished on wave advance.
const _smokeGrenades = [];   // { px,py,pz, vx,vy,vz, life }
const _smokeClouds   = [];   // { x,y,z, life, maxLife, meshes[] }
let   _smokeAmmo     = SMOKE_COUNT;

function _fireSmokeGrenade() {
  if (_smokeAmmo <= 0 || !player.alive) return;
  _smokeAmmo--;
  if (hudSmoke) hudSmoke.textContent = `SMOKE ${_smokeAmmo}`;
  const heading = player.heading + player.turretYaw;
  const sinH = Math.sin(heading), cosH = Math.cos(heading);
  const el = 0.38;    // ~22° arc — high enough to clear obstacles
  const spd = 28;
  _smokeGrenades.push({
    px: player.position.x,
    py: player.position.y + 1.6,
    pz: player.position.z,
    vx: -sinH * Math.cos(el) * spd,
    vy:  Math.sin(el) * spd,
    vz: -cosH * Math.cos(el) * spd,
    life: 6.0,
  });
}

function _spawnSmokeCloud(x, y, z) {
  // Four overlapping puffs at slightly different heights/offsets for a natural look
  const offsets = [[0, 0, 0], [2.8, 1.2, 1.2], [-2.2, 0.8, 2.5], [1.2, 2.8, -1.5]];
  const meshes = [];
  for (const [ox, oy, oz] of offsets) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xc8c8c8, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 7, 5), mat);
    m.position.set(x + ox, y + oy + 1.8, z + oz);
    scene.add(m);
    meshes.push(m);
  }
  _smokeClouds.push({ x, y, z, life: SMOKE_LIFE, maxLife: SMOKE_LIFE, meshes });
}

function _updateSmokeGrenades(dt) {
  for (let i = _smokeGrenades.length - 1; i >= 0; i--) {
    const g = _smokeGrenades[i];
    g.vy -= CONFIG.GRAVITY * dt;
    g.px += g.vx * dt;
    g.py += g.vy * dt;
    g.pz += g.vz * dt;
    g.life -= dt;
    const ground = getAltitude(g.px, g.pz);
    if (g.py <= ground || g.life <= 0) {
      _spawnSmokeCloud(g.px, Math.max(g.py, ground), g.pz);
      _smokeGrenades.splice(i, 1);
    }
  }
}

function _updateSmokeClouds(dt) {
  for (let i = _smokeClouds.length - 1; i >= 0; i--) {
    const c = _smokeClouds[i];
    c.life -= dt;
    const elapsed    = c.maxLife - c.life;
    const expandFrac = Math.min(1, elapsed / SMOKE_EXPAND);
    const fadeAlpha  = c.life < SMOKE_FADE ? c.life / SMOKE_FADE : 1.0;
    for (let j = 0; j < c.meshes.length; j++) {
      const r = (SMOKE_PUFF_R * 0.50 + j * SMOKE_PUFF_R * 0.14) * expandFrac;
      c.meshes[j].scale.setScalar(r);
      c.meshes[j].material.opacity = (0.20 + j * 0.02) * fadeAlpha;
    }
    if (c.life <= 0) {
      for (const m of c.meshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
      _smokeClouds.splice(i, 1);
    }
  }
}

// Returns true when the player is inside a sufficiently expanded smoke cloud
function _isInSmoke(x, z) {
  for (const c of _smokeClouds) {
    const elapsed = c.maxLife - c.life;
    if (elapsed < SMOKE_EXPAND * 0.4) continue;   // still too thin
    const dx = x - c.x, dz = z - c.z;
    if (dx * dx + dz * dz < SMOKE_PUFF_R * SMOKE_PUFF_R * 0.65) return true;
  }
  return false;
}

function _resetSmoke() {
  _smokeGrenades.length = 0;
  for (const c of _smokeClouds) {
    for (const m of c.meshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  }
  _smokeClouds.length = 0;
  _smokeAmmo = SMOKE_COUNT;
  if (hudSmoke) hudSmoke.textContent = `SMOKE ${_smokeAmmo}`;
}

// ─── Artillery functions ──────────────────────────────────────────────────────
function _callArtillery() {
  if (_artilleryCharges <= 0 || !player.alive) return;
  _artilleryCharges--;
  if (hudArty) hudArty.textContent = `ARTY ${_artilleryCharges}`;

  // Ballistic aim point — use real range formula so aim elevation controls distance.
  // R = v² × sin(2θ) / g, clamped to map-safe range.
  const heading = player.heading + player.turretYaw;
  const el   = Math.max(player.gunElevation ?? 0.06, 0.02);
  const R    = Math.max(30, Math.min(300, 80 * 80 * Math.sin(2 * el) / CONFIG.GRAVITY));
  const tx   = player.position.x - Math.sin(heading) * R;
  const tz   = player.position.z - Math.cos(heading) * R;

  // Queue shells with staggered timers; first impact after ARTY_DELAY seconds
  for (let i = 0; i < ARTY_SHELLS; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r     = ARTY_SPREAD * Math.sqrt(Math.random());   // uniform disk spread
    _artilleryQueue.push({
      x:     tx + Math.cos(angle) * r,
      z:     tz + Math.sin(angle) * r,
      timer: ARTY_DELAY + i * 0.40 + Math.random() * 0.25,
    });
  }

  // Audio: descending whistle to signal incoming
  audio.playIncoming();

  // HUD callout (reuses hit-indicator slot)
  if (hudHitIndicator) {
    hudHitIndicator.textContent = '◉  ARTILLERY — INCOMING';
    hudHitIndicator.style.color = 'rgba(255, 220, 60, 0.95)';
    hudHitIndicator.style.opacity = '1';
    _hitIndTimer = ARTY_DELAY + 0.6;
  }
}

function _updateArtillery(dt) {
  if (_spotterTimer > 0) _spotterTimer -= dt;
  for (let i = _artilleryQueue.length - 1; i >= 0; i--) {
    _artilleryQueue[i].timer -= dt;
    if (_artilleryQueue[i].timer > 0) continue;

    const { x, z } = _artilleryQueue[i];
    const y = getAltitude(x, z);
    _artilleryQueue.splice(i, 1);

    // Visual + audio
    particles.explosion(x, y, z);
    const ddx = x - player.position.x, ddz = z - player.position.z;
    const dist = Math.sqrt(ddx * ddx + ddz * ddz);
    audio.playExplosion(dist);
    addCrater(x, z, 1.8);
    addShake(Math.max(0, 2.5 * (1 - dist / 45)));

    // Area damage to all tanks in blast radius
    for (const t of allTanks) {
      if (!t.alive) continue;
      const dx = t.position.x - x, dz = t.position.z - z;
      const d  = Math.sqrt(dx * dx + dz * dz);
      if (d < ARTY_BLAST_R) {
        const falloff   = 1 - d / ARTY_BLAST_R;
        const dmg       = Math.max(1, Math.round(ARTY_BLAST_DMG * falloff * t.damageMult));
        t.hp = Math.max(0, t.hp - dmg);
        if (t.hp <= 0 && t.alive) {
          t.alive = false;
          _processTankDeath(t, player);
        }
      }
    }
  }
}

function _resetArtillery() {
  _artilleryQueue.length = 0;
  _artilleryCharges = ARTY_CHARGES;
  if (hudArty) hudArty.textContent = `ARTY ${_artilleryCharges}`;
}

function _callSpotter() {
  if (_spotterCharges <= 0 || !player.alive) return;
  _spotterCharges--;
  if (hudSpotter) hudSpotter.textContent = `SPOT ${_spotterCharges}`;
  _spotterTimer = SPOTTER_DURATION;
}

function _resetSpotter() {
  _spotterCharges = SPOTTER_CHARGES;
  _spotterTimer   = 0;
  if (hudSpotter) hudSpotter.textContent = `SPOT ${SPOTTER_CHARGES}`;
}

// ─── Supply crate functions ────────────────────────────────────────────────────
function _clearCrates() {
  for (const c of _crates) {
    // Only dispose geometry; materials are shared cached instances
    if (c.mesh) { scene.remove(c.mesh); c.mesh.geometry.dispose(); }
  }
  _crates.length = 0;
}

function _spawnCrates() {
  _clearCrates();
  const M = CONFIG.MAP_HALF - 50;
  for (const ct of _crateTypes) {
    let x = 0, z = 0, tries = 0;
    do {
      x = (Math.random() * 2 - 1) * M;
      z = (Math.random() * 2 - 1) * M;
      tries++;
    } while (tries < 30 && (Math.sqrt(x * x + z * z) < 40 || getAltitude(x, z) < CONFIG.SEA_LEVEL + 2));
    const y = getAltitude(x, z) + 0.7;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 1.5, 2.0),
      _crateMaterials(ct),
    );
    mesh.position.set(x, y, z);
    scene.add(mesh);
    _crates.push({ x, z, y, type: ct.type, mesh, alive: true, phase: Math.random() * Math.PI * 2 });
  }
}

function _collectCrate(c) {
  c.alive = false;
  scene.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null;
  const ct = _crateTypes.find(t => t.type === c.type);
  if (c.type === 'hp') {
    player.hp = Math.min(player.maxHp, player.hp + 25);
  } else if (c.type === 'smoke') {
    _smokeAmmo = Math.min(SMOKE_COUNT * 2, _smokeAmmo + SMOKE_COUNT);
    if (hudSmoke) hudSmoke.textContent = `SMOKE ${_smokeAmmo}`;
  } else if (c.type === 'arty') {
    _artilleryCharges = Math.min(ARTY_CHARGES * 2, _artilleryCharges + 1);
    if (hudArty) hudArty.textContent = `ARTY ${_artilleryCharges}`;
  }
  if (hudHitIndicator && ct) {
    hudHitIndicator.textContent  = ct.label;
    hudHitIndicator.style.color  = ct.hColor;
    hudHitIndicator.style.opacity = '1';
    _hitIndTimer = 3.0;
  }
}

function _updateCrates(dt) {
  if (!player.alive) return;
  for (const c of _crates) {
    if (!c.alive) continue;
    c.phase += dt * 2.4;
    c.mesh.rotation.y += dt * 0.6;
    c.mesh.position.y = c.y + Math.sin(c.phase) * 0.22 + 0.22;
    const dx = player.position.x - c.x;
    const dz = player.position.z - c.z;
    if (dx * dx + dz * dz < CRATE_COLLECT_R * CRATE_COLLECT_R) _collectCrate(c);
  }
}

// ─── Tank recovery (Attrition / Strategy) ─────────────────────────────────────
function _updateWrecks(dt) {
  if (_wrecks.length === 0) return;
  const isSquadMode = _gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY;
  if (!isSquadMode || !player.alive) {
    // Hide all labels, rings, and bar
    for (const wr of _wrecks) {
      if (wr.labelEl)   wr.labelEl.style.display = 'none';
      if (wr.ringMesh)  wr.ringMesh.visible = false;
    }
    if (_hudRecoveryBar)    _hudRecoveryBar.style.display    = 'none';
    if (_hudRecoveryPrompt) _hudRecoveryPrompt.style.display = 'none';
    return;
  }

  let nearestWreck   = null;
  let nearestDist    = Infinity;
  const playerSpeed  = Math.abs(player.leftSpeed + player.rightSpeed) * 0.5;

  for (const wr of _wrecks) {
    const dx   = player.position.x - wr.tank.position.x;
    const dz   = player.position.z - wr.tank.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Update "RECOVERABLE" label — project wreck position to screen
    if (wr.labelEl) {
      if (dist < WRECK_LABEL_R) {
        _tempProjVec.set(wr.tank.position.x, wr.tank.position.y + 4 * wr.tank.def.modelScale, wr.tank.position.z);
        _tempProjVec.project(camera);
        if (_tempProjVec.z < 1) {
          const sx = (_tempProjVec.x + 1) / 2 * window.innerWidth;
          const sy = (-_tempProjVec.y + 1) / 2 * window.innerHeight;
          wr.labelEl.style.display = '';
          wr.labelEl.style.left    = sx + 'px';
          wr.labelEl.style.top     = sy + 'px';
        } else {
          wr.labelEl.style.display = 'none';
        }
      } else {
        wr.labelEl.style.display = 'none';
      }
    }

    // Recovery zone ring — fade out as player enters the zone
    if (wr.ringMesh) {
      const fade = Math.min(1, dist / WRECK_RECOVER_R);
      wr.ringMesh.material.opacity = 0.60 * fade;
      wr.ringMesh.visible = dist < WRECK_LABEL_R;
    }

    if (dist < nearestDist) {
      nearestDist  = dist;
      nearestWreck = wr;
    }
  }

  // Check for recovery interruption (player moved or took damage)
  if (_recoveringWreck) {
    const moved   = playerSpeed >= 1.0;
    const damaged = player.hp < _recoveryHp;
    if (moved || damaged) {
      _recoveringWreck = null;
      _recoveryTimer   = 0;
      if (_hudRecoveryBar) _hudRecoveryBar.style.display = 'none';
      // Show interruption message in hit indicator
      if (hudHitIndicator) {
        hudHitIndicator.textContent = 'RECOVERY INTERRUPTED';
        hudHitIndicator.style.color = 'rgba(255,180,60,0.95)';
        hudHitIndicator.style.opacity = '1';
        _hitIndTimer = 2.0;
      }
    }
  }

  // Show prompt and advance recovery timer
  const inRange = nearestWreck && nearestDist < WRECK_RECOVER_R;
  const inPrompt = nearestWreck && nearestDist < WRECK_PROMPT_R;

  if (inRange && playerSpeed < 1.0) {
    // In range and stationary — advance recovery
    if (_recoveringWreck !== nearestWreck) {
      // Started targeting a new wreck
      _recoveringWreck = nearestWreck;
      _recoveryTimer   = 0;
      _recoveryHp      = player.hp;
    }
    _recoveryTimer += dt;
    _recoveryHp = Math.min(_recoveryHp, player.hp); // track lowest HP for damage detect

    const pct = Math.min(1, _recoveryTimer / WRECK_RECOVER_T);
    const filled = Math.round(pct * 10);
    const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);
    if (_hudRecoveryBar) {
      _hudRecoveryBar.style.display  = '';
      _hudRecoveryBar.textContent    = `RECOVERING... [${bar}] ${Math.round(pct * 100)}%`;
    }
    if (_hudRecoveryPrompt) _hudRecoveryPrompt.style.display = 'none';

    if (_recoveryTimer >= WRECK_RECOVER_T) {
      // Recovery complete!
      const wr   = _recoveringWreck;
      const tank = wr.tank;
      tank._noRescue = true;
      tank.hp        = Math.round(tank.maxHp * 0.25);
      tank.alive     = true;

      // Restore the mesh: show turret, remove tilt, restore vertex colour multiplier
      tank.turretGroup.visible = true;
      tank.mesh.traverse(obj => {
        if (obj.isMesh && obj.material && obj.material.color && obj.material.vertexColors) {
          obj.material.color.setHex(0xFFFFFF);
        }
      });
      // Reset any random lean from setDestroyed()
      tank.mesh.rotation.set(0, 0, 0);
      tank._orient();

      // Stop wreck smoke
      if (wr.smoker) wr.smoker.active = false;

      // Remove label and ring
      if (wr.labelEl) { wr.labelEl.remove(); wr.labelEl = null; }
      if (wr.ringMesh) {
        scene.remove(wr.ringMesh);
        wr.ringMesh.geometry.dispose();
        wr.ringMesh.material.dispose();
        wr.ringMesh = null;
      }

      // Remove from _wrecks
      _wrecks.splice(_wrecks.indexOf(wr), 1);

      // Add back as wingman (if not already)
      if (!wingmen.includes(tank)) {
        wingmen.push(tank);
        wingmanAIs.push(new WingmanController(tank));
      }

      _recoveringWreck = null;
      _recoveryTimer   = 0;
      if (_hudRecoveryBar) _hudRecoveryBar.style.display = 'none';

      if (hudHitIndicator) {
        hudHitIndicator.textContent = `TANK RECOVERED — ${tank.def.name} at 25% HP`;
        hudHitIndicator.style.color = 'rgba(80,255,120,0.95)';
        hudHitIndicator.style.opacity = '1';
        _hitIndTimer = 3.5;
      }
    }
  } else {
    // Not in recovery range — clear any active recovery
    if (_recoveringWreck) {
      _recoveringWreck = null;
      _recoveryTimer   = 0;
      if (_hudRecoveryBar) _hudRecoveryBar.style.display = 'none';
    }
    // Show prompt if in prompt range
    if (inPrompt && _hudRecoveryPrompt) {
      _hudRecoveryPrompt.style.display  = '';
      _hudRecoveryPrompt.textContent    = `Hold position near wreck to recover (${WRECK_RECOVER_T}s)`;
    } else if (_hudRecoveryPrompt) {
      _hudRecoveryPrompt.style.display = 'none';
    }
  }
}

// ─── Shell pass-by tracking ───────────────────────────────────────────────────
const _shellPassbySet = new Set();   // shells that have already triggered a pass-by sound

// ─── Supply crates ─────────────────────────────────────────────────────────────
const _crateTypes = [
  { type: 'hp',    color: 0xDD3333, mmColor: '#DD3333', label: '◆ +25 HP RESTORED',     hColor: 'rgba(255,100,100,0.95)' },
  { type: 'smoke', color: 0x2266EE, mmColor: '#2266EE', label: '◆ SMOKE REPLENISHED',   hColor: 'rgba(100,160,255,0.95)' },
  { type: 'arty',  color: 0xDDAA11, mmColor: '#DDAA11', label: '◆ ARTILLERY CHARGE +1', hColor: 'rgba(255,220,60,0.95)'  },
];
const _crates = [];

function _createCrateTexture(cssColor, drawSymbolFn) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, size - 8, size - 8);
  drawSymbolFn(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

function _drawHPSymbol(ctx, size) {
  const cx = size / 2, cy = size / 2;
  const armW = size * 0.18, armL = size * 0.32;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(cx - armW/2 - 1, cy - armL - 1, armW + 2, armL * 2 + 2);
  ctx.fillRect(cx - armL - 1, cy - armW/2 - 1, armL * 2 + 2, armW + 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(cx - armW/2, cy - armL, armW, armL * 2);
  ctx.fillRect(cx - armL, cy - armW/2, armL * 2, armW);
}

function _drawSmokeSymbol(ctx, size) {
  const cx = size / 2, cy = size / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath(); ctx.arc(cx - size*0.12, cy + size*0.04, size*0.14, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + size*0.12, cy + size*0.04, size*0.14, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx,             cy - size*0.08, size*0.17, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + size*0.08, cy - size*0.16, size*0.09, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(cx - size*0.22, cy + size*0.06, size*0.44, size*0.08);
}

function _drawArtySymbol(ctx, size) {
  const cx = size / 2, cy = size / 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  for (let t = 0; t <= 1; t += 0.02) {
    const x = cx - size*0.3 + t * size*0.6;
    const y = cy + size*0.2 - Math.sin(t * Math.PI) * size*0.42;
    if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  const t = 0.7;
  const shellX = cx - size*0.3 + t * size*0.6;
  const shellY = cy + size*0.2 - Math.sin(t * Math.PI) * size*0.42;
  const angle = Math.atan2(-Math.cos(t * Math.PI) * size*0.42 * Math.PI, size*0.6);
  ctx.save();
  ctx.translate(shellX, shellY);
  ctx.rotate(angle);
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.beginPath(); ctx.ellipse(0, 0, size*0.07, size*0.03, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(size*0.07, 0); ctx.lineTo(size*0.11, -size*0.015); ctx.lineTo(size*0.11, size*0.015);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  const lx = cx - size*0.3, ly = cy + size*0.2;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI/2;
    const r = size * 0.04;
    ctx.beginPath(); ctx.arc(lx + Math.cos(a)*r, ly + Math.sin(a)*r, size*0.015, 0, Math.PI*2); ctx.fill();
  }
}

// Cached per-type textures and material arrays (created once, reused across spawns)
const _crateTextures = {
  hp:    _createCrateTexture('#DD3333', _drawHPSymbol),
  smoke: _createCrateTexture('#2266EE', _drawSmokeSymbol),
  arty:  _createCrateTexture('#DDAA11', _drawArtySymbol),
};
function _crateMaterials(ct) {
  const sideMat  = new THREE.MeshLambertMaterial({ map: _crateTextures[ct.type] });
  const plainMat = new THREE.MeshLambertMaterial({ color: ct.color });
  // BoxGeometry face order: +X, -X, +Y (top), -Y (bottom), +Z, -Z
  return [sideMat, sideMat, plainMat, plainMat, sideMat, sideMat];
}

// ─── Gun-sight state ──────────────────────────────────────────────────────────
let _sightMode    = false;
let _sightMouseDX = 0;
let _sightMouseDY = 0;

document.addEventListener('mousemove', e => {
  if (_sightMode) { _sightMouseDX += e.movementX; _sightMouseDY += e.movementY; }
});
// If pointer lock is released externally (Esc pressed by browser), exit sight mode cleanly
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && _sightMode) _exitSightMode();
});

function _enterSightMode() {
  _sightMode = true;
  camera.fov = CONFIG.SIGHT_FOV;
  camera.updateProjectionMatrix();
  renderer.domElement.requestPointerLock();
}

function _exitSightMode() {
  _sightMode    = false;
  _sightMouseDX = 0;
  _sightMouseDY = 0;
  camera.fov = 60;
  camera.updateProjectionMatrix();
  if (hudSight) hudSight.style.display = 'none';
  if (document.pointerLockElement) document.exitPointerLock();
}

// Place camera behind the barrel root looking along the gun direction.
// Camera is offset backward along the horizontal gun heading (no elevation component
// in the pullback, so the viewpoint never dips into the terrain on steep slopes).
function _updateSightCamera() {
  const gunH  = player.heading + player.turretYaw;
  const el    = player.gunElevation ?? 0.06;
  const sinH  = Math.sin(gunH);
  const cosH  = Math.cos(gunH);
  const cosEl = Math.cos(el);
  const sinEl = Math.sin(el);

  // Pull back behind the turret along the reverse horizontal gun heading
  const PULL_BACK = 3.5;  // world units — clears the hull body
  const camX = player.position.x + sinH * PULL_BACK;
  const camZ = player.position.z + cosH * PULL_BACK;

  // Sit at barrel height, clamped above terrain at the pulled-back position
  const barrelY  = player.position.y + player.muzzleHeight;
  const terrainY = getAltitude(camX, camZ);
  const camY     = Math.max(terrainY + 0.8, barrelY);

  camera.position.set(camX, camY, camZ);

  const FAR = 800;
  camera.lookAt(
    camX - sinH * cosEl * FAR,
    camY + sinEl        * FAR,
    camZ - cosH * cosEl * FAR,
  );
}

// ─── Animation loop ───────────────────────────────────────────────────────────
let lastTime = performance.now();

function animate(now) {
  requestAnimationFrame(animate);

  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  // ── Pause toggle (P key — edge-detect) ───────────────────────────────────────
  {
    const pauseKey = input.pause;
    if (pauseKey && !prevPauseKey &&
        (game.state === STATES.PLAYING || game.state === STATES.PAUSED)) {
      game.togglePause();
      updateOverlay();
    }
    prevPauseKey = pauseKey;
  }

  // ── Gun-sight toggle (V key) ──────────────────────────────────────────────────
  if (game.state === STATES.PLAYING && player.alive && input.sightToggle) {
    if (_sightMode) _exitSightMode(); else _enterSightMode();
  }

  // ── Ammo type toggle / tank switch (Tab key) ────────────────────────────────
  if (game.state === STATES.PLAYING && player.alive && input.ammoSwitch) {
    if (_gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY) {
      // Tab = cycle to next alive squad tank
      const nextIdx = _nextAliveTank();
      if (nextIdx >= 0) switchControlledTank(nextIdx);
    } else {
      // Tab = ammo switch (Arcade / wave mode)
      _ammoType = _ammoType === 'AP' ? 'HE' : 'AP';
      if (hudAmmo) {
        hudAmmo.textContent = _ammoType;
        hudAmmo.style.color = _ammoType === 'HE'
          ? 'rgba(200, 255, 0, 0.95)'
          : 'rgba(120, 255, 120, 0.85)';
      }
    }
  }

  // ── Death camera (runs even after game.isPlaying goes false) ────────────────
  if (!player.alive && _deathCamTimer >= 0) {
    _deathCamTimer += dt;
    _deathCamAngle += DEATH_CAM_SPEED * dt;
    camera.position.set(
      player.position.x + Math.sin(_deathCamAngle) * DEATH_CAM_RADIUS,
      player.position.y + DEATH_CAM_HEIGHT,
      player.position.z + Math.cos(_deathCamAngle) * DEATH_CAM_RADIUS,
    );
    // Look toward midpoint between wreck and killer when killer is still alive
    if (_killer && _killer.alive) {
      camera.lookAt(
        (player.position.x + _killer.position.x) * 0.5,
        (player.position.y + _killer.position.y) * 0.5 + 2,
        (player.position.z + _killer.position.z) * 0.5,
      );
    } else {
      camera.lookAt(player.position.x, player.position.y + 2, player.position.z);
    }
    if (_deathCamTimer >= DEATH_CAM_DURATION) {
      if (_gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY) {
        // Squad mode: switch to next alive squad tank (or game over handled by end conditions)
        _deathCamTimer = -1;
        const nextIdx = _nextAliveTank();
        if (nextIdx >= 0) switchControlledTank(nextIdx);
        else updateOverlay();
      } else if (_pendingRespawn) {
        _pendingRespawn = false;
        _respawnPlayer();
      } else {
        _deathCamTimer = -1;  // deactivate
        updateOverlay();
      }
    }
  }

  // ── Tank preview (menu only) ──────────────────────────────────────────────────
  if (_prevRenderer && _prevMeshRoot) {
    const isMenu = game.state === STATES.MENU || (game.state === STATES.LAN_LOBBY && !_lanRoomCode);
    if (_prevCanvas) _prevCanvas.style.display = isMenu ? 'block' : 'none';
    if (isMenu) {
      _prevAngle += 0.4 * dt;
      _prevMeshRoot.rotation.y = _prevAngle;
      _prevRenderer.render(_prevScene, _prevCamera);
    }
  }

  // ── Skip simulation when not playing ─────────────────────────────────────────
  if (!game.isPlaying) {
    // Keep fire/smoke alive on wrecks during death cam
    particles.update(dt);
    if (hudSight) hudSight.style.display = 'none';
    _sky.position.copy(camera.position);
    renderer.render(scene, camera);
    input.tick();
    return;
  }

  // ── LAN duel game loop (takes over from normal loop when active) ─────────────
  if (_lanMode && _lanGameActive) {
    _runLanFrame(dt, now);
    weather.update(dt);
    weather.applyToScene(scene.fog, _skyGeo);
    _sky.position.copy(camera.position);
    renderer.render(scene, camera);
    input.tick();
    return;
  }

  // ── Player ───────────────────────────────────────────────────────────────────
  // Engine pitch/volume follows player speed (or idles when dead/stopped)
  {
    const spd = (Math.abs(player.leftSpeed) + Math.abs(player.rightSpeed)) * 0.5;
    audio.setEngineSpeed(Math.min(spd / player.maxSpeed, 1));
  }

  // ── Sight overlay visibility ──────────────────────────────────────────────────
  if (hudSight) hudSight.style.display = (_sightMode && player.alive) ? 'flex' : 'none';

  if (player.alive) {
    {
      // ── Demo mode: AI drives the player until any input is detected ─────────
      // (_cancelDemo is wired to keydown/mousedown/touchstart — no per-frame input check needed)
      if (_demoActive && _demoAI && enemies.length > 0) {
        const demoTarget = enemies.find(e => e.alive) ?? null;
        if (demoTarget) {
          _demoAI.update(dt, demoTarget, combat, particles, false);
          player.update(dt, { skipAccel: true, turretLeft:false, turretRight:false, fire:false, fireOnce:false });
        } else {
          player.update(dt, input);
        }
      } else {
        player.update(dt, input);
      }
      // Always drive internal camera lerp state, then optionally override for sight
      player.updateCamera(camera, dt);
      if (_sightMode) {
        // Mouse look: rotate turret and elevate gun from accumulated mouse movement
        player.turretYaw   += _sightMouseDX * SIGHT_YAW_SENS;
        player.gunElevation = Math.max(ELEV_MIN, Math.min(ELEV_MAX,
          (player.gunElevation ?? 0.06) - _sightMouseDY * SIGHT_ELEV_SENS));
        _sightMouseDX = 0;
        _sightMouseDY = 0;
        _updateSightCamera();
      }
    }

    // ── Mouse aim — rotate turret toward mouse world position at 80% turret speed ──
    if (_mouseAimEnabled && !_sightMode) {
      const ndcX = (_mouseX / window.innerWidth)  *  2 - 1;
      const ndcY = (_mouseY / window.innerHeight) * -2 + 1;
      _aimRaycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
      _aimPlane.constant = -player.position.y;
      if (_aimRaycaster.ray.intersectPlane(_aimPlane, _aimHitPoint)) {
        const dx = _aimHitPoint.x - player.position.x;
        const dz = _aimHitPoint.z - player.position.z;
        const desiredYaw = Math.atan2(-dx, -dz) - player.heading;
        let yawDiff = desiredYaw - player.turretYaw;
        yawDiff = ((yawDiff % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
        const rate    = player.def.turretSpeed * 0.012 * player.turretSpeedMult * 0.80;
        const maxStep = rate * dt;
        player.turretYaw += Math.sign(yawDiff) * Math.min(Math.abs(yawDiff), maxStep);
      }
    }

    // ── Aim assist — nudge player turret toward nearest enemy in range ──────────
    // Disabled in sight mode, when mouse aim is active, and when manually using Q/E.
    // After Q/E is released, auto-turret stays paused for 6 seconds before resuming.
    const _manualTurret = input.turretLeft || input.turretRight;
    if (_manualTurret) _manualTurretPauseTimer = 6.0;
    else if (_manualTurretPauseTimer > 0) _manualTurretPauseTimer -= dt;
    let assistTarget = null;
    let assistDist   = (!_sightMode && !_mouseAimEnabled && _manualTurretPauseTimer <= 0 && _aimAssist && input.simpleMode) ? CONFIG.ASSIST_RANGE : 0;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.position.x - player.position.x;
      const dz = e.position.z - player.position.z;
      const d  = Math.sqrt(dx * dx + dz * dz);
      if (d < assistDist) { assistDist = d; assistTarget = e; }
    }
    if (assistTarget) {
      const dx = assistTarget.position.x - player.position.x;
      const dz = assistTarget.position.z - player.position.z;
      const targetWorldHeading = Math.atan2(-dx, -dz);
      let desiredYaw = targetWorldHeading - player.heading;
      let yawDiff = desiredYaw - player.turretYaw;
      yawDiff = ((yawDiff % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
      const _immobBoost = player.hp < 12 ? 8 : 1;
      player.turretYaw += yawDiff * Math.min(DIFFICULTY.aimAssistStrength * _immobBoost * dt, 1);
      // Ballistic elevation to compensate for height difference
      const horiz = Math.sqrt(dx * dx + dz * dz);
      player.gunElevation = ballisticElevation(horiz, assistTarget.position.y - player.position.y);
    } else if (!_sightMode) {
      player.gunElevation = 0.06;
    }

    // ── Turret idle return — snap back to straight-ahead after 5s of inactivity ──
    // Resets on: manual turret input, aim-assist acquisition, sight mode, mouse aim.
    const _turretActive = _manualTurret || assistTarget || _sightMode || _mouseAimEnabled;
    if (_turretActive) {
      _turretIdleTimer = 0;
    } else {
      _turretIdleTimer += dt;
      if (_turretIdleTimer >= 5.0 && Math.abs(player.turretYaw) > 0.001) {
        let yawDiff = -player.turretYaw;
        yawDiff = ((yawDiff % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
        const returnRate = player.def.turretSpeed * 0.012 * player.turretSpeedMult;
        player.turretYaw += Math.sign(yawDiff) * Math.min(Math.abs(yawDiff), returnRate * dt);
      }
    }

    // ── Damage smoke (>50%=none, 25-50%=light, 12-25%=heavy+fire, <12%=tracks wrecked) ─
    const hpTier = player.hp < 12 ? 3 : player.hp < 25 ? 2 : player.hp < 50 ? 1 : 0;
    if (hpTier !== _prevHpTier) {
      if (hpTier === 0) {
        if (_damageSmoke) { _damageSmoke.active = false; _damageSmoke = null; }
      } else {
        if (_damageSmoke) { _damageSmoke.active = false; _damageSmoke = null; }
        _damageSmoke = particles.addSmoker(hpTier >= 2 ? 2 : 1);
        if (hudHitIndicator) {
          const msg = hpTier === 3 ? '⚠  TRACKS WRECKED — IMMOBILISED'
                    : hpTier === 2 ? '⚠  CRITICAL DAMAGE — ENGINE FIRE'
                    :                '⚠  HULL DAMAGE — SPEED REDUCED';
          hudHitIndicator.textContent = msg;
          hudHitIndicator.style.color = 'rgba(255, 100, 40, 0.95)';
          hudHitIndicator.style.opacity = '1';
          _hitIndTimer = 3.0;
        }
      }
      _prevHpTier = hpTier;
    }
    if (_damageSmoke) {
      _damageSmoke.x = player.position.x;
      _damageSmoke.y = player.position.y + 1.5 * player.def.modelScale;
      _damageSmoke.z = player.position.z;
      // Lean column opposite to tank travel direction; clamp to ≤45° (drift ≤ upBias * speed)
      const spd  = Math.abs(player.leftSpeed + player.rightSpeed) * 0.5;
      const lean = Math.min(spd * 0.15, 0.8);
      _damageSmoke.driftX = -Math.sin(player.heading) * lean;
      _damageSmoke.driftZ = -Math.cos(player.heading) * lean;
    }
  }

  // ── NPC damage smoke — enemies and wingmen ────────────────────────────────────
  for (const t of allTanks) {
    if (t === player) continue;
    if (!t.alive) {
      // Clean up smoker when tank dies (burner added separately in _processTankDeath)
      const entry = _npcSmokers.get(t);
      if (entry && entry.smoker) { entry.smoker.active = false; entry.smoker = null; }
      continue;
    }
    let entry = _npcSmokers.get(t);
    if (!entry) { entry = { smoker: null, tier: 0 }; _npcSmokers.set(t, entry); }

    const tier = t.hp < 12 ? 3 : t.hp < 25 ? 2 : t.hp < 50 ? 1 : 0;
    if (tier !== entry.tier) {
      if (entry.smoker) { entry.smoker.active = false; entry.smoker = null; }
      if (tier > 0) entry.smoker = particles.addSmoker(tier >= 2 ? 2 : 1);
      entry.tier = tier;
    }
    if (entry.smoker) {
      entry.smoker.x = t.position.x;
      entry.smoker.y = t.position.y + 1.5 * t.def.modelScale;
      entry.smoker.z = t.position.z;
      const spd  = Math.abs(t.leftSpeed + t.rightSpeed) * 0.5;
      const lean = Math.min(spd * 0.15, 0.8);
      entry.smoker.driftX = -Math.sin(t.heading) * lean;
      entry.smoker.driftZ = -Math.cos(t.heading) * lean;
    }
  }

  // ── Road speed bonus / water speed penalty / weather — update all alive tanks ──
  const _wSpeedMult = weather.getSpeedMultiplier();
  for (const t of allTanks) {
    if (t.alive) {
      t.roadBonus    = _isOnRoad(t.position.x, t.position.z);
      t.waterMult    = _waterSpeedMult(t.position.x, t.position.z);
      t.weatherMult  = _wSpeedMult;
    }
  }

  // ── Track trails + mud spray ──────────────────────────────────────────────────
  for (const t of allTanks) {
    if (!t.alive) continue;
    const spd = Math.abs(t.leftSpeed + t.rightSpeed) * 0.5;
    if (spd > 0.5) {
      _getTrail(t).update(t.position.x, t.position.z, t.heading);

      const spawnRate = Math.min(spd * 0.04 + 0.10, 0.40);
      if (Math.random() < spawnRate) {
        const bx = Math.sin(t.heading + Math.PI);
        const bz = Math.cos(t.heading + Math.PI);
        const px =  Math.cos(t.heading);
        const pz = -Math.sin(t.heading);
        const rear  = t.def.hitRadius * 0.65;
        const track = t.def.hitRadius * 0.45;
        for (const side of [-1, 1]) {
          particles.mudSpray(
            t.position.x + bx * rear + px * side * track,
            t.position.y,
            t.position.z + bz * rear + pz * side * track,
            bx, bz,
          );
        }
      }
    }
  }

  // ── Wingman AI ────────────────────────────────────────────────────────────────
  for (let i = 0; i < wingmen.length; i++) {
    if (!wingmen[i].alive) continue;
    if (_debugAiDisabled) {
      // WingmanController writes leftSpeed/rightSpeed directly each frame, so
      // skipping the controller alone leaves stale speed values — zero them explicitly.
      wingmen[i].leftSpeed = 0;
      wingmen[i].rightSpeed = 0;
    } else {
      wingmanAIs[i].update(dt, enemies, combat, particles);
    }
    wingmen[i].update(dt, { skipAccel: true, turretLeft:false, turretRight:false, fire:false, fireOnce:false });
  }

  // ── Enemy AI ─────────────────────────────────────────────────────────────────
  // Suppress AI fire when player is inside a smoke cloud
  const _playerObscured = _isInSmoke(player.position.x, player.position.z);
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    if (!enemy.alive) continue;
    if (_debugAiDisabled) {
      enemy.leftSpeed  = 0;
      enemy.rightSpeed = 0;
    } else {
      aiControllers[i].update(dt, player, combat, particles, _playerObscured, weather.getDetectionMultiplier(), weather.getFireIntervalMultiplier(), weather.getEngageRangeMultiplier());
    }
    enemy.update(dt, { skipAccel: true, turretLeft:false, turretRight:false, fire:false, fireOnce:false });
  }

  // ── Tank-tank collision ───────────────────────────────────────────────────────
  // Push overlapping tanks apart; damp speeds to simulate a solid impact.
  for (let i = 0; i < allTanks.length; i++) {
    for (let j = i + 1; j < allTanks.length; j++) {
      const a = allTanks[i];
      const b = allTanks[j];
      if (!a.alive || !b.alive) continue;
      const dx   = b.position.x - a.position.x;
      const dz   = b.position.z - a.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minD = a.hitRadius + b.hitRadius;
      if (dist < minD && dist > 0.001) {
        const overlap = (minD - dist) * 0.5;
        const nx = dx / dist;
        const nz = dz / dist;
        a.position.x -= nx * overlap;
        a.position.z -= nz * overlap;
        b.position.x += nx * overlap;
        b.position.z += nz * overlap;

        // Stop any tank that is actively driving INTO the other; only damp the rest.
        // This prevents AI tanks from grinding against the player indefinitely.
        const aAvg  = (a.leftSpeed + a.rightSpeed) * 0.5;
        const bAvg  = (b.leftSpeed + b.rightSpeed) * 0.5;
        const aFwdN = -Math.sin(a.heading) * nx - Math.cos(a.heading) * nz;
        const bFwdN = -Math.sin(b.heading) * nx - Math.cos(b.heading) * nz;
        if (aAvg * aFwdN > 0) { a.leftSpeed = 0; a.rightSpeed = 0; }
        else                   { a.leftSpeed *= COLL_DAMP; a.rightSpeed *= COLL_DAMP; }
        if (bAvg * bFwdN < 0) { b.leftSpeed = 0; b.rightSpeed = 0; }
        else                   { b.leftSpeed *= COLL_DAMP; b.rightSpeed *= COLL_DAMP; }

        // Sync mesh positions after push
        a.mesh.position.x = a.position.x;
        a.mesh.position.z = a.position.z;
        b.mesh.position.x = b.position.x;
        b.mesh.position.z = b.position.z;
      }
    }
  }

  // ── Tank-building collision ───────────────────────────────────────────────────
  // Tick down cooldowns
  for (const [t, cd] of _buildingDmgCooldown) {
    const newCd = cd - dt;
    if (newCd <= 0) _buildingDmgCooldown.delete(t);
    else _buildingDmgCooldown.set(t, newCd);
  }
  for (const t of allTanks) {
    if (!t.alive) continue;
    for (const b of _buildings) {
      if (!b.alive) continue;
      const dx   = t.position.x - b.x;
      const dz   = t.position.z - b.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minD = t.hitRadius + b.radius;
      if (dist < minD && dist > 0.001) {
        const push = (minD - dist) / dist;
        t.position.x += dx * push;
        t.position.z += dz * push;
        t.leftSpeed  *= 0.1;
        t.rightSpeed *= 0.1;
        t.mesh.position.x = t.position.x;
        t.mesh.position.z = t.position.z;
        // Apply building-impact damage (5-10% scaled by speed), max once per 0.5 s
        if (!_buildingDmgCooldown.has(t)) {
          const _bSpd = Math.abs(t.leftSpeed + t.rightSpeed) * 0.5;
          const _bDmg = Math.max(1, Math.round(5 + 5 * Math.min(1, _bSpd / (t.def.maxSpeed * 0.20))));
          t.hp = Math.max(0, t.hp - _bDmg);
          _buildingDmgCooldown.set(t, 0.5);
          if (t.hp <= 0 && t.alive) { t.alive = false; _processTankDeath(t, null); }
        }
      }
    }
  }

  // ── Wreck collision — pushes tanks out of wreck hulls (no damage) ────────────
  for (const t of allTanks) {
    if (!t.alive) continue;
    for (const wr of _wrecks) {
      const dx   = t.position.x - wr.tank.position.x;
      const dz   = t.position.z - wr.tank.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minD = t.hitRadius + wr.tank.hitRadius;
      if (dist < minD && dist > 0.001) {
        const push = (minD - dist) / dist;
        t.position.x += dx * push;
        t.position.z += dz * push;
        t.leftSpeed  *= 0.15;
        t.rightSpeed *= 0.15;
        t.mesh.position.x = t.position.x;
        t.mesh.position.z = t.position.z;
      }
    }
  }

  // ── Tank-tree collision — destroys the tree on contact ───────────────────────
  for (const t of allTanks) {
    if (!t.alive) continue;
    const searchR = (t.hitRadius + TREE_COLL_R) * (t.hitRadius + TREE_COLL_R);
    const nearby  = chunkManager.getTreesNear(t.position.x, t.position.z, searchR);
    for (const tree of nearby) {
      const dx   = t.position.x - tree.wx;
      const dz   = t.position.z - tree.wz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minD = t.hitRadius + TREE_COLL_R;
      if (dist < minD && dist > 0.001) {
        // Push tank out and damp speed
        const push = (minD - dist) / dist;
        t.position.x += dx * push;
        t.position.z += dz * push;
        t.leftSpeed  *= 0.3;
        t.rightSpeed *= 0.3;
        t.mesh.position.x = t.position.x;
        t.mesh.position.z = t.position.z;
        // Destroy the tree — burst at tree base + minor HP damage scaled by speed
        chunkManager.destroyTree(tree.key, tree.idx);
        particles.treeBurst(tree.wx, tree.alt, tree.wz);
        const _tSpd = Math.abs(t.leftSpeed + t.rightSpeed) * 0.5;
        const _tDmg = Math.max(1, Math.round(1 + 2 * Math.min(1, _tSpd / (t.def.maxSpeed * 0.20))));
        t.hp = Math.max(0, t.hp - _tDmg);
        if (t.hp <= 0 && t.alive) { t.alive = false; _processTankDeath(t, null); }
      }
    }
  }

  // ── Map boundary — invisible wall ────────────────────────────────────────────
  const M = CONFIG.MAP_HALF;
  for (const t of allTanks) {
    if (!t.alive) continue;
    let clamped = false;
    if (t.position.x >  M) { t.position.x =  M; clamped = true; }
    if (t.position.x < -M) { t.position.x = -M; clamped = true; }
    if (t.position.z >  M) { t.position.z =  M; clamped = true; }
    if (t.position.z < -M) { t.position.z = -M; clamped = true; }
    if (clamped) {
      t.leftSpeed  *= 0.05;
      t.rightSpeed *= 0.05;
      t.mesh.position.x = t.position.x;
      t.mesh.position.z = t.position.z;
    }
  }

  // ── Hit indicator fade ────────────────────────────────────────────────────────
  if (hudHitIndicator && _hitIndTimer > 0) {
    if (!_upgradeAvailable) {
      _hitIndTimer -= dt;
      hudHitIndicator.style.opacity = Math.max(0, Math.min(1, _hitIndTimer / 0.8)).toFixed(2);
    }
  }

  // ── Encounter messages (not shown in Arcade — player is the only human) ──────
  if (player.alive && game.state === STATES.PLAYING && _gameMode !== MODES.ARCADE) {
    for (const e of enemies) {
      if (!e.alive || _encounteredEnemies.has(e)) continue;
      const dx = e.position.x - player.position.x;
      const dz = e.position.z - player.position.z;
      if (dx * dx + dz * dz < ENCOUNTER_RANGE * ENCOUNTER_RANGE) {
        _encounteredEnemies.add(e);
        _showEncounter(player.def.name, e.def.name);
        break; // one encounter message at a time
      }
    }
  }
  // Fade encounter/weather message in all modes (weather fires in Arcade too)
  if (hudEncounter && _encounterTimer > 0) {
    _encounterTimer -= dt;
    hudEncounter.style.opacity = Math.max(0, Math.min(1, _encounterTimer / 0.8)).toFixed(2);
  }

  // ── Debug panel visibility ───────────────────────────────────────────────────
  if (_debugMode) _updateDebugPanel();

  // ── Tank name flash fade ──────────────────────────────────────────────────────
  if (hudTankNameFlash && _tankNameFlashTimer > 0) {
    _tankNameFlashTimer -= dt;
    hudTankNameFlash.style.opacity = Math.max(0, Math.min(1, _tankNameFlashTimer / 0.8)).toFixed(2);
  }

  // ── Edge-of-map warning + boundary grid visibility ───────────────────────────
  {
    const M = CONFIG.MAP_HALF;
    const px = player.position.x, pz = player.position.z;
    const nearEdge = player.alive && (
      Math.abs(px) > M * 0.95 || Math.abs(pz) > M * 0.95
    );
    if (hudEdgeWarning) hudEdgeWarning.style.display = nearEdge ? 'block' : 'none';
    // Show wireframe grid only within 2% of the edge
    _boundaryWalls[0].visible = player.alive && pz <= -M * 0.98;  // north
    _boundaryWalls[1].visible = player.alive && pz >=  M * 0.98;  // south
    _boundaryWalls[2].visible = player.alive && px <= -M * 0.98;  // west
    _boundaryWalls[3].visible = player.alive && px >=  M * 0.98;  // east
  }

  // ── Firing (player) ──────────────────────────────────────────────────────────
  if (player.alive && (input.fireOnce || _mouseFireOnce)) {
    const tip = combat.fire(player, _ammoType);
    if (tip) { particles.muzzleFlash(tip.x, tip.y, tip.z); audio.playFire(); addShake(0.7); }
  }
  _mouseFireOnce = false;

  // ── Smoke grenade / artillery / spotter plane (Strategy mode only — desktop; Attrition mobile) ─
  if (player.alive && _gameMode === MODES.STRATEGY) {
    if (input.smokeOnce)    _fireSmokeGrenade();
    if (input.artilleryOnce) _callArtillery();
    if (input.spotterOnce)  _callSpotter();
  }
  // ── Shell pass-by detection ───────────────────────────────────────────────────
  if (player.alive) {
    for (const shell of combat.shells) {
      if (shell.firedBy.def.faction !== 'german') continue;
      if (_shellPassbySet.has(shell)) continue;
      const dx = shell.px - player.position.x;
      const dz = shell.pz - player.position.z;
      if (dx * dx + dz * dz < PASSBY_R * PASSBY_R) {
        _shellPassbySet.add(shell);
        audio.playPassby();
      }
    }
    // Purge dead shells from set to avoid unbounded growth
    for (const s of _shellPassbySet) {
      if (!combat.shells.includes(s)) _shellPassbySet.delete(s);
    }
  }

  // ── Combat resolution ─────────────────────────────────────────────────────────
  const impacts = combat.update(dt, allTanks);
  for (const imp of impacts) {
    const ddx  = imp.x - player.position.x;
    const ddz  = imp.z - player.position.z;
    const dist = Math.sqrt(ddx * ddx + ddz * ddz);

    if (imp.tank) {
      // ── Shell hit a tank ──────────────────────────────────────────────────────
      if (imp.penetrated) {
        particles.explosion(imp.x, imp.y, imp.z);
        if (imp.tank === player) {
          audio.playHit();
          addShake(Math.min(7, imp.damage * 0.14));
          if (hudDamageFlash) {
            hudDamageFlash.classList.remove('flash-active');
            void hudDamageFlash.offsetWidth;   // force reflow to restart animation
            hudDamageFlash.classList.add('flash-active');
          }
        } else {
          audio.playExplosion(dist);
          addShake(Math.max(0, 2.8 * (1 - dist / 28)));  // concussion from nearby kill
        }
      } else {
        // Deflection: gold spark, distinct ricochet ping
        particles.ricochet(imp.x, imp.y, imp.z);
        audio.playRicochet();
      }
    } else {
      // ── Shell hit ground / timed out ─────────────────────────────────────────
      particles.explosion(imp.x, imp.y, imp.z);
      audio.playExplosion(dist);
      addShake(Math.max(0, 1.5 * (1 - dist / 20)));      // near miss concussion
      addCrater(imp.x, imp.z, imp.shellType === 'HE' ? 2.2 : 1.0);
      // Destroy any tree within blast radius and show burst
      const blastR = imp.shellType === 'HE' ? 5.5 : 2.5;
      for (const tree of chunkManager.getTreesNear(imp.x, imp.z, blastR * blastR)) {
        chunkManager.destroyTree(tree.key, tree.idx);
        particles.treeBurst(tree.wx, tree.alt, tree.wz);
      }
    }

    // Hit indicator — only shown for player-fired shells hitting enemy tanks
    if (hudHitIndicator && imp.firedBy === player && imp.tank && imp.tank !== player) {
      const zone = imp.hitDot <= -0.707 ? 'FRONT' : imp.hitDot >= 0.707 ? 'REAR' : 'SIDE';
      if (imp.penetrated) {
        hudHitIndicator.textContent  = `${zone}  ·  HIT  ·  ${imp.damage} DMG`;
        hudHitIndicator.style.color  = 'rgba(120, 255, 120, 0.95)';
      } else if (imp.ricochet) {
        hudHitIndicator.textContent  = `${zone}  ·  RICOCHET`;
        hudHitIndicator.style.color  = 'rgba(200, 210, 220, 0.95)';
      } else {
        hudHitIndicator.textContent  = `${zone}  ·  DEFLECTED`;
        hudHitIndicator.style.color  = 'rgba(255, 220, 60, 0.95)';
      }
      hudHitIndicator.style.opacity = '1';
      _hitIndTimer = imp.penetrated ? 2.0 : 1.5;
    }
    if (imp.tank && !imp.tank.alive) {
      const _overkill = Math.max(0, (imp.damage || 0) - (imp.preHitHp || 0));
      _processTankDeath(imp.tank, imp.firedBy, _overkill);
      if (wingmen.includes(imp.tank) && hudHitIndicator) {
        hudHitIndicator.textContent = '✖  FRIENDLY TANK DESTROYED';
        hudHitIndicator.style.color = 'rgba(255, 100, 60, 0.95)';
        hudHitIndicator.style.opacity = '1';
        _hitIndTimer = 3.5;
      }
    }

    // ── Player/ally shot alerts nearby enemies to retarget immediately ─────────
    // Direct hit: alert the struck tank's controller.
    // Near miss: alert any enemy AI within 8m of impact point.
    if (imp.firedBy === player || wingmen.includes(imp.firedBy)) {
      for (let ci = 0; ci < aiControllers.length; ci++) {
        const ai = aiControllers[ci];
        if (!ai.tank.alive) continue;
        const isDirectHit = imp.tank === ai.tank;
        if (!isDirectHit) {
          const ex = ai.tank.position.x - imp.x;
          const ez = ai.tank.position.z - imp.z;
          if (ex * ex + ez * ez > 64) continue;   // > 8m, skip
        }
        ai.alertToPlayer();
      }
    }
  }

  // ── HE splash damage ──────────────────────────────────────────────────────────
  // Any HE impact — direct or ground — blasts all tanks within HE_SPLASH_R.
  for (const imp of impacts) {
    if (imp.shellType !== 'HE') continue;
    for (const t of allTanks) {
      if (t === imp.tank) continue;   // already handled by direct-hit path
      if (!t.alive) continue;
      const dx = t.position.x - imp.x;
      const dz = t.position.z - imp.z;
      const d  = Math.sqrt(dx * dx + dz * dz);
      if (d < HE_SPLASH_R) {
        const falloff   = 1 - d / HE_SPLASH_R;
        const splashDmg = Math.max(1, Math.round(HE_SPLASH_DMG * falloff * t.damageMult));
        t.hp = Math.max(0, t.hp - splashDmg);
        if (t.hp <= 0 && t.alive) {
          t.alive = false;
          _processTankDeath(t, player);
          addShake(Math.max(0, 3.5 * (1 - d / HE_SPLASH_R)));
        }
      }
    }
  }

  particles.update(dt);
  _updateSmokeGrenades(dt);
  _updateSmokeClouds(dt);
  _updateArtillery(dt);
  _updateCrates(dt);
  _updateWrecks(dt);

  // ── Dynamic weather ───────────────────────────────────────────────────────────
  weather.update(dt);
  weather.applyToScene(scene.fog, _skyGeo);
  const _wMsg = weather.consumeMessage();
  if (_wMsg && hudEncounter) {
    hudEncounter.textContent = _wMsg;
    hudEncounter.style.opacity = '1';
    _encounterTimer = 5.0;
  }

  // ── Shell-vs-building hit detection ──────────────────────────────────────────
  // Shells that survived tank/terrain checks this frame are still in combat.shells.
  // Test each against live buildings; destroy building and consume shell on impact.
  for (let si = combat.shells.length - 1; si >= 0; si--) {
    const shell = combat.shells[si];
    for (const b of _buildings) {
      if (!b.alive) continue;
      // Vertical check: shell must be below the roofline
      if (shell.py > b.y + b.h + 1) continue;
      const dx = shell.px - b.x, dz = shell.pz - b.z;
      if (dx * dx + dz * dz < b.radius * b.radius) {
        const ddx = shell.px - player.position.x;
        const ddz = shell.pz - player.position.z;
        particles.explosion(shell.px, shell.py, shell.pz);
        audio.playExplosion(Math.sqrt(ddx * ddx + ddz * ddz));
        addShake(Math.max(0, 1.4 * (1 - Math.sqrt(ddx * ddx + ddz * ddz) / 28)));
        destroyBuilding(b);
        shell.dispose();
        combat.shells.splice(si, 1);
        break;
      }
    }
  }

  // ── Kill tracking ─────────────────────────────────────────────────────────────
  for (let i = 0; i < enemies.length; i++) {
    if (prevAlive[i] && !enemies[i].alive) {
      game.addKill(enemies[i].def);
      prevAlive[i] = false;
      _arcadeKillTracked();
    }
  }

  // ── Squad death tracking (Attrition / Strategy) ───────────────────────────────
  if (_gameMode !== MODES.ARCADE && _playerSquad.length > 0) {
    for (let i = 0; i < _playerSquad.length; i++) {
      if (_prevSquadAlive[i] && !_playerSquad[i].alive) {
        _prevSquadAlive[i] = false;
        _showSquadHUD();
        // Score penalty for losing a friendly tank
        game.score = Math.max(0, game.score - 50);
      }
    }
  }

  // ── Objective (Strategy) ──────────────────────────────────────────────────────
  if (_gameMode === MODES.STRATEGY) _updateObjective(dt);

  // ── End-condition checks ──────────────────────────────────────────────────────
  if (_gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY) {
    game.checkSquadEndConditions(_playerSquad, enemies);
  } else if (_gameMode === MODES.ARCADE) {
    // Arcade: all enemies dead → short delay so the last wreck/explosion is visible,
    // then auto-spawn the next wave.
    if (game.state === STATES.PLAYING && enemies.every(e => !e.alive) && !_pendingRespawn) {
      if (_waveEndTimer < 0) {
        _waveEndTimer = 2.0;  // 2 s to show the last death before clearing
      } else {
        _waveEndTimer -= dt;
        if (_waveEndTimer <= 0) {
          _waveEndTimer = -1;
          game.wave++;
          if (_arcadeClass === 3) _arcadeHeavyWave++;
          clearCraters(); _resetSmoke(); _resetArtillery(); _resetSpotter();
          player.hp = Math.min(player.maxHp, player.hp + 30);
          spawnArcadeWave();
        }
      }
    } else {
      _waveEndTimer = -1;  // reset if player dies mid-delay
      game.checkEndConditions(player, enemies, _pendingRespawn);
    }
  } else {
    game.checkEndConditions(player, enemies, _pendingRespawn);
  }
  // Suppress overlay while death camera is active (it calls updateOverlay itself)
  if (!game.isPlaying && _deathCamTimer < 0) updateOverlay();

  // ── Target acquisition ───────────────────────────────────────────────────────
  // Find the closest alive enemy within the gun-sight cone each frame
  if (hudTarget) {
    let lockedEnemy = null;
    if (player.alive) {
      const gunH  = player.heading + player.turretYaw;
      const CONE  = _sightMode ? 0.07 : 0.20;   // ~4° in sight, ~11.5° in 3rd-person
      let   best  = Infinity;
      for (const e of enemies) {
        if (!e.alive) continue;
        const dx   = e.position.x - player.position.x;
        const dz   = e.position.z - player.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const angleToE = Math.atan2(-dx, -dz);
        let   adiff    = ((angleToE - gunH) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
        if (Math.abs(adiff) < CONE && dist < best) { best = dist; lockedEnemy = e; }
      }
    }
    if (lockedEnemy) {
      const dx   = lockedEnemy.position.x - player.position.x;
      const dz   = lockedEnemy.position.z - player.position.z;
      const dist = Math.round(Math.sqrt(dx * dx + dz * dz) * 1.4 / 10) * 10;  // wu→m, round to 10
      const pct  = Math.max(0, Math.round(lockedEnemy.hp));
      const bars = Math.round(pct / 12.5);
      const bar  = '\u25A0'.repeat(bars) + '\u25A1'.repeat(8 - bars);
      hudTargetName.textContent = '\u25C8  ' + lockedEnemy.def.name.toUpperCase();
      hudTargetBar.textContent  = bar + '  ' + pct + '%  \u00B7  ' + dist + 'm';
      hudTarget.style.display = 'block';
    } else {
      hudTarget.style.display = 'none';
    }
  }

  // ── Terrain ───────────────────────────────────────────────────────────────────
  chunkManager.update(player.position.x, player.position.z);

  // ── Camera shake ─────────────────────────────────────────────────────────────
  if (_shakeMag > 0.004) {
    _shakeMag *= Math.exp(-SHAKE_DECAY * dt);
    const mag = _sightMode ? _shakeMag * 0.3 : _shakeMag;  // sight dampens vibration
    const a   = Math.random() * Math.PI * 2;
    camera.position.x += Math.cos(a) * mag;
    camera.position.y += (Math.random() - 0.5) * mag * 0.4;
    camera.position.z += Math.sin(a) * mag;
  } else {
    _shakeMag = 0;
  }

  _sky.position.copy(camera.position);
  renderer.render(scene, camera);

  // ── HUD (~2 Hz) ───────────────────────────────────────────────────────────────
  fpsCount++;
  if (now - fpsTime >= 500) {
    const fps = Math.round(fpsCount / ((now - fpsTime) / 1000));
    fpsCount = 0;
    fpsTime  = now;

    if (hudFps)     hudFps.textContent     = `${fps}`;
    if (hudPhase)   hudPhase.textContent  = `Wave ${game.wave} / ${game.totalWaves}`;
    if (hudSpeed)   hudSpeed.textContent   = `${player.speedKmh} km/h`;
    if (hudHeading) hudHeading.textContent = `${player.headingDeg}°`;
    if (hudPos)     hudPos.textContent     =
      `${Math.round(player.position.x)}, ${Math.round(player.position.y)}, ${Math.round(player.position.z)}`;
    if (hudScore)   hudScore.textContent   = `${game.score}`;
    if (hudEnemies) {
      const alive = enemies.filter(e => e.alive).length;
      hudEnemies.textContent = `${alive} / ${enemies.length}`;
    }

    if (hudReload) {
      if (player.reloadTimer >= player.reloadTime) {
        hudReload.textContent = '● READY';
        hudReload.style.color = 'rgba(120,255,120,0.85)';
      } else {
        const pct = Math.round(player.reloadTimer / player.reloadTime * 100);
        hudReload.textContent = `◦ RELOADING ${pct}%`;
        hudReload.style.color = 'rgba(180,180,180,0.5)';
      }
    }

    if (hudHp) {
      const pct = Math.round(player.hp / player.maxHp * 100);
      hudHp.textContent   = `HP ${pct}%`;
      hudHp.style.color   = pct > 50 ? 'rgba(120,255,120,0.85)'
                          : pct > 25 ? 'rgba(255,200,80,0.9)'
                          :            'rgba(255,80,80,0.95)';
    }
    if (hudSpeedState) {
      const pct = Math.round(player.hp / player.maxHp * 100);
      if (pct <= 12) {
        hudSpeedState.textContent = '⚠ Immobilised — tracks wrecked';
        hudSpeedState.style.color = 'rgba(255,80,80,0.95)';
        hudSpeedState.style.display = '';
      } else if (pct <= 25) {
        hudSpeedState.textContent = '⚠ Quarter speed — critical damage';
        hudSpeedState.style.color = 'rgba(255,140,60,0.90)';
        hudSpeedState.style.display = '';
      } else if (pct <= 50) {
        hudSpeedState.textContent = '⚠ Half speed — hull damage';
        hudSpeedState.style.color = 'rgba(255,200,80,0.85)';
        hudSpeedState.style.display = '';
      } else {
        hudSpeedState.style.display = 'none';
      }
    }
  }

  // ── Minimap ───────────────────────────────────────────────────────────────────
  updateMinimap();
  input.tick();
}

animate(performance.now());
