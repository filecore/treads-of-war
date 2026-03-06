// main.js — Phase 5: Game states (menu / playing / paused / game-over / victory)

import * as THREE from 'three';
import { CONFIG }         from './config.js';
import { ChunkManager, getAltitude } from './terrain.js';
import { Input }          from './input.js';
import { Tank }           from './tank.js';
import { buildAuthenticModel } from './models.js';
import { CombatManager, ballisticElevation }  from './combat.js';
import { ParticleSystem } from './particles.js';
import { AIController, WingmanController } from './ai.js';
import { GameManager, STATES } from './game.js';
import {
  MODES, KILLS_TO_UPGRADE, ARCADE_CLASSES,
  ATTRITION_PLAYER_FLEETS, ATTRITION_ENEMY_FLEETS,
  STRATEGY_BUDGETS, TANK_COSTS, FACTION_ROSTERS,
  OBJECTIVE_HOLD_REQ, OBJECTIVE_RADIUS, OBJECTIVE_CONTEST_R,
} from './modes.js';
import { AudioManager }        from './audio.js';
import { DIFFICULTY }          from './config.js';
import { Net, LAN_SNAP_HZ }   from './net.js';

// ─── Gameplay constants ───────────────────────────────────────────────────────
const ASSIST_RANGE       = 80;   // world units — aim assist activates within this distance
const ASSIST_RATE        = 0.5;  // fraction of remaining yaw error corrected per second (subtle pull)
const COLL_DAMP          = 0.55; // speed multiplier applied to both tanks on collision
const PLAYER_RELOAD_MULT = 0.75; // player reloads 25% faster than config baseline
const DEATH_CAM_DURATION = 4.0;  // seconds of death-camera orbit before overlay appears
const DEATH_CAM_SPEED    = 0.35; // radians per second — orbit rotation speed
const DEATH_CAM_RADIUS   = 30;   // world units — orbit radius around wreck
const DEATH_CAM_HEIGHT   = 18;   // world units above wreck
const SIGHT_FOV          = 14;   // degrees — gun-sight camera field of view (~4× zoom)
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
const SMOKE_COUNT        = 3;    // smoke grenades replenished each wave
const SMOKE_PUFF_R       = 11;   // cloud radius at full size (world units)
const SMOKE_LIFE         = 14;   // seconds cloud persists after deploying
const SMOKE_EXPAND       = 2.5;  // seconds to reach full radius
const SMOKE_FADE         = 4.0;  // seconds of fade-out at end of life

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
  _prevRenderer.setClearColor(0x6A6A72, 1);   // neutral mid-grey — contrasts with all faction colours and dark barrel
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
  const built  = buildAuthenticModel(def, tankKey, false);
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
  particles.dispose();   // disposes all burners and smokers
  _npcSmokers.clear();   // stale tank references removed; new smokers will be created on demand
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
// Terrain-following quad-strip roads.  Each path is a list of [x, z] waypoints;
// a CatmullRomCurve3 is fitted through terrain-height samples and flattened into a
// triangle strip.  _roadSplines stores sampled points for minimap rendering and
// on-road speed-bonus testing.
const ROAD_WIDTH   = 7;
const _roadMat     = new THREE.MeshLambertMaterial({ color: CONFIG.COLOURS.road, side: THREE.DoubleSide });
const _roadSplines = [];   // [ [THREE.Vector3, ...], ... ]  — one array per road

const ROAD_PATHS = [
  // Northern E-W highway — runs through the upper third of the map
  [[-285, -115], [-175, -100], [-55, -85], [75, -75], [195, -65], [285, -90]],
  // Western N-S corridor — crosses the map from north to south on the left side
  [[-85, -285], [-100, -170], [-120, -85], [-110, 45], [-95, 165], [-75, 285]],
  // Eastern diagonal — links south-east to north-east, avoiding the centre
  [[200, -285], [160, -160], [105, -45], [70, 85], [55, 205], [90, 285]],
];

(function buildRoads() {
  for (const path of ROAD_PATHS) {
    const pts3d = path.map(([x, z]) => new THREE.Vector3(x, getAltitude(x, z) + 0.2, z));
    const curve = new THREE.CatmullRomCurve3(pts3d);
    const N     = Math.max(24, Math.round(curve.getLength() / 3));
    const spline = curve.getSpacedPoints(N);   // evenly-spaced for minimap + speed check
    _roadSplines.push(spline);

    const posArr = [];
    const idxArr = [];
    for (let i = 0; i <= N; i++) {
      const pt  = spline[i];
      const tan = curve.getTangent(i / N).normalize();
      const rx  =  tan.z;   // right vector components (perpendicular in XZ plane)
      const rz  = -tan.x;
      const hw  = ROAD_WIDTH / 2;
      // Re-sample terrain height at each vertex so the road follows hills exactly
      // rather than dipping underground between sparse waypoints.
      const lx = pt.x - rx * hw, lz = pt.z - rz * hw;
      const rx2 = pt.x + rx * hw, rz2 = pt.z + rz * hw;
      posArr.push(lx,  getAltitude(lx,  lz)  + 0.35, lz,
                  rx2, getAltitude(rx2, rz2) + 0.35, rz2);
      if (i < N) {
        const a = i * 2;
        idxArr.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
    geo.setIndex(idxArr);
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, _roadMat));
  }
})();

// Returns true if world position (x, z) is within half road-width of any road
function _isOnRoad(x, z) {
  const threshold = (ROAD_WIDTH * 0.5) * (ROAD_WIDTH * 0.5);
  for (const spline of _roadSplines) {
    for (const pt of spline) {
      const dx = x - pt.x, dz = z - pt.z;
      if (dx * dx + dz * dz < threshold) return true;
    }
  }
  return false;
}

// Roads are now built — set filter and load initial chunks.
chunkManager.setRoadFilter(_isOnRoad);
chunkManager.update(0, 0);

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
{
  function _seededRng(seed) {
    let v = (seed ^ 0xDEADBEEF) >>> 0;
    return () => { v = (Math.imul(v, 1664525) + 1013904223) >>> 0; return v / 0x100000000; };
  }
  const rng = _seededRng(0xC0FFEE42);

  for (const spline of _roadSplines) {
    for (let si = 0; si < spline.length - 1; si += 8) {
      if (rng() > 0.30) continue;                           // 30% of positions spawn a cluster

      const clusterSize = 2 + Math.floor(rng() * 3);        // 2–4 houses
      const segA = spline[si];
      const segB = spline[Math.min(si + 8, spline.length - 1)];

      // Road-segment tangent + perpendicular normal (XZ plane)
      const tdx = segB.x - segA.x, tdz = segB.z - segA.z;
      const tlen = Math.sqrt(tdx * tdx + tdz * tdz) || 1;
      const nx =  tdz / tlen;   // left normal
      const nz = -tdx / tlen;

      for (let ci = 0; ci < clusterSize; ci++) {
        const t       = rng();
        const side    = rng() > 0.5 ? 1 : -1;
        const sideOff = (ROAD_WIDTH * 0.8 + rng() * ROAD_WIDTH * 1.8) * side;

        const hx = segA.x + tdx * t + nx * sideOff;
        const hz = segA.z + tdz * t + nz * sideOff;
        const gy = getAltitude(hx, hz);

        if (gy < CONFIG.SEA_LEVEL + 2) continue;
        if (_isOnRoad(hx, hz)) continue;

        const { group, w, d, h } = createHouse(rng() > 0.5);
        group.position.set(hx, gy, hz);

        // Orient so front face (-Z local) faces toward the nearest point on the road segment
        const faceX = (segA.x + tdx * 0.5) - hx;
        const faceZ = (segA.z + tdz * 0.5) - hz;
        // atan2(-faceX, -faceZ) maps local -Z axis toward the road direction
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

// ─── Player ───────────────────────────────────────────────────────────────────
const input  = new Input();
let player = new Tank(scene, 'sherman');
player.reloadTime  = player.reloadTime * PLAYER_RELOAD_MULT;
player.reloadTimer = player.reloadTime;   // start already loaded

// ─── Player tank roster (non-German, selectable at menu) ──────────────────────
const WINGMAN_ROSTER = ['m24', 't34', 'kv1s', 'sherman'];   // lighter Allied tanks for wingman
let _selIdx = 1;   // index within current faction roster

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

// Attrition state — fleet persists across battles
let _attritionBattle = 0;
let _playerFleet     = [];  // all allied Tank instances
let _controlledIdx   = 0;   // which fleet tank player controls
let _prevFleetAlive  = [];  // for fleet death tracking

// Strategy state
let _strategyLevel   = 0;
let _strategyBudget  = STRATEGY_BUDGETS[0];
let _purchaseFleet   = {};  // { tankKey: count }
let _purchaseSelIdx  = 0;   // cursor in purchase screen

// Objective (Strategy)
let _objectivePos    = null;  // { x, z }
let _objectiveHold   = 0;     // seconds currently held
let _objectiveMesh   = null;
let _objectiveLabel  = null;

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
  _spawnCrates();
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
function _spawnEnemyList(typeList) {
  for (const e of enemies) e.dispose(scene);
  enemies = []; aiControllers = []; prevAlive = [];
  const count = typeList.length;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + 0.3;
    const dist  = 130 + Math.random() * 70;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const t = new Tank(scene, typeList[i], true);
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
  _spawnCrates();
}

// ─── Attrition mode spawn (uses persistent _playerFleet) ─────────────────────
function spawnAttritionBattle() {
  clearBattleDebris();
  const faction    = _selectedFaction();
  const fleetDefs  = ATTRITION_PLAYER_FLEETS[faction];
  const enemyFleet = faction === 'german' ? ATTRITION_ENEMY_FLEETS.allies : ATTRITION_ENEMY_FLEETS.german;
  const battleIdx  = Math.min(_attritionBattle, enemyFleet.length - 1);
  const enemyTypes = enemyFleet[battleIdx];

  // Build or reuse player fleet tanks (first battle = spawn fresh)
  if (_playerFleet.length === 0) {
    for (const [i, type] of fleetDefs.entries()) {
      const angle = (i / fleetDefs.length) * Math.PI + Math.PI; // south side
      const dist  = 20 + i * 8;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      const t = new Tank(scene, type, false);
      t.position.set(x, getAltitude(x, z), z);
      t.mesh.position.copy(t.position);
      t.heading = 0;
      _playerFleet.push(t);
    }
    _controlledIdx = 0;
  } else {
    // Re-position surviving fleet tanks for next battle
    const survivors = _playerFleet.filter(t => t.alive);
    for (const [i, t] of survivors.entries()) {
      const angle = (i / survivors.length) * Math.PI + Math.PI;
      const dist  = 20 + i * 8;
      t.position.set(Math.cos(angle) * dist, getAltitude(0, 0), Math.sin(angle) * dist);
      t.mesh.position.copy(t.position);
      t.leftSpeed = t.rightSpeed = 0;
    }
    // Re-index controlled to first alive tank
    _controlledIdx = _playerFleet.findIndex(t => t.alive);
  }
  _prevFleetAlive = _playerFleet.map(t => t.alive);

  // player = currently controlled fleet tank
  player = _playerFleet[_controlledIdx];

  // All other alive fleet tanks become wingmen
  wingmen    = [];
  wingmanAIs = [];
  for (const [i, t] of _playerFleet.entries()) {
    if (i === _controlledIdx || !t.alive) continue;
    wingmen.push(t);
    wingmanAIs.push(new WingmanController(t));
  }

  _spawnEnemyList(enemyTypes);
  allTanks = [..._playerFleet, ...enemies];
  _spawnCrates();
  _showFleetHUD();
}

// ─── Strategy mode spawn (uses _purchaseFleet) ────────────────────────────────
function spawnStrategyBattle() {
  clearBattleDebris();
  // First call: dispose the phantom Sherman (not yet in _playerFleet)
  if (_playerFleet.length === 0) player.dispose(scene);
  // Build player fleet from purchase choices
  for (const t of _playerFleet) t.dispose(scene);
  _playerFleet = [];
  _controlledIdx = 0;

  const entries = Object.entries(_purchaseFleet).filter(([, n]) => n > 0);
  let idx = 0;
  for (const [type, count] of entries) {
    for (let c = 0; c < count; c++) {
      const angle = (idx / Math.max(1, _purchaseTotal())) * Math.PI + Math.PI;
      const dist  = 20 + idx * 8;
      const x = Math.cos(angle) * dist, z = Math.sin(angle) * dist;
      const t = new Tank(scene, type, false);
      t.position.set(x, getAltitude(x, z), z);
      t.mesh.position.copy(t.position);
      _playerFleet.push(t);
      idx++;
    }
  }
  if (_playerFleet.length === 0) return; // shouldn't happen

  _prevFleetAlive = _playerFleet.map(() => true);
  player = _playerFleet[0];

  // AI enemy fleet: fill budget with best tanks it can afford
  const enemyBudget = _strategyBudget;
  const enemyTypes  = _aiPurchase(enemyBudget);
  _spawnEnemyList(enemyTypes);

  // Remaining fleet tanks as wingmen
  wingmen    = [];
  wingmanAIs = [];
  for (let i = 1; i < _playerFleet.length; i++) {
    wingmen.push(_playerFleet[i]);
    wingmanAIs.push(new WingmanController(_playerFleet[i]));
  }

  allTanks = [..._playerFleet, ...enemies];
  _spawnCrates();
  _buildObjective();
  _showFleetHUD();
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
  return Object.values(_purchaseFleet).reduce((s, n) => s + n, 0);
}

function _purchaseCost() {
  return Object.entries(_purchaseFleet)
    .reduce((s, [k, n]) => s + (TANK_COSTS[k] ?? 0) * n, 0);
}

// ─── Objective (Strategy) ─────────────────────────────────────────────────────
function _buildObjective() {
  if (_objectiveMesh) { scene.remove(_objectiveMesh); _objectiveMesh.geometry.dispose(); }
  const angle = Math.random() * Math.PI * 2;
  const dist  = 150 + Math.random() * 80;
  _objectivePos = { x: Math.cos(angle) * dist, z: Math.sin(angle) * dist };
  _objectiveHold = 0;

  const y = getAltitude(_objectivePos.x, _objectivePos.z) + 0.15;
  const geo = new THREE.RingGeometry(OBJECTIVE_RADIUS - 1.5, OBJECTIVE_RADIUS, 32);
  const mat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.6, depthWrite: false });
  _objectiveMesh = new THREE.Mesh(geo, mat);
  _objectiveMesh.rotation.x = -Math.PI / 2;
  _objectiveMesh.position.set(_objectivePos.x, y, _objectivePos.z);
  scene.add(_objectiveMesh);
}

function _updateObjective(dt) {
  if (!_objectivePos || game.state !== STATES.PLAYING) return;
  const holdEl = document.getElementById('hud-objective');

  // Check if any fleet tank is inside the objective
  const fleetInside = _playerFleet.some(t => {
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

  if (fleetInside && !contested) {
    _objectiveHold += dt;
    // Pulse the ring brighter as time progresses
    if (_objectiveMesh) {
      const t = Math.min(1, _objectiveHold / OBJECTIVE_HOLD_REQ);
      _objectiveMesh.material.color.setHex(t > 0.5 ? 0xFFFF44 : 0xFFFFFF);
      _objectiveMesh.material.opacity = 0.5 + t * 0.4;
    }
    if (holdEl) holdEl.textContent = `OBJ ${Math.ceil(OBJECTIVE_HOLD_REQ - _objectiveHold)}s`;
    if (_objectiveHold >= OBJECTIVE_HOLD_REQ) {
      // Objective captured — battle won!
      game.state = STATES.BATTLE_COMPLETE;
    }
  } else {
    if (fleetInside && contested) {
      // Reset hold when contested
      _objectiveHold = 0;
      if (holdEl) holdEl.textContent = 'OBJ CONTESTED';
    } else {
      if (holdEl) holdEl.textContent = fleetInside ? 'OBJ HOLD...' : 'OBJ CAPTURE';
    }
    if (_objectiveMesh) {
      _objectiveMesh.material.color.setHex(0xFFFFFF);
      _objectiveMesh.material.opacity = 0.6;
    }
  }
}

// ─── Tank switching (Attrition / Strategy) ────────────────────────────────────
function switchControlledTank(newIdx) {
  if (newIdx === _controlledIdx) return;
  if (!_playerFleet[newIdx] || !_playerFleet[newIdx].alive) return;

  const oldTank = player;

  // Hand old tank to AI
  if (!wingmen.includes(oldTank)) {
    wingmen.push(oldTank);
    wingmanAIs.push(new WingmanController(oldTank));
  }

  // Remove new tank from AI control
  const wi = wingmen.indexOf(_playerFleet[newIdx]);
  if (wi >= 0) { wingmen.splice(wi, 1); wingmanAIs.splice(wi, 1); }

  _controlledIdx = newIdx;
  player = _playerFleet[newIdx];
  player._camInit = false;
  _exitSightMode();

  if (hudName)    hudName.textContent    = player.def.name;
  if (hudFaction) hudFaction.textContent = _factionLabel(player.def.faction).toUpperCase();
  _showFleetHUD();
}

function _nextAliveTank() {
  const n = _playerFleet.length;
  for (let i = 1; i <= n; i++) {
    const idx = (_controlledIdx + i) % n;
    if (_playerFleet[idx].alive) return idx;
  }
  return -1;
}

// ─── Fleet HUD helper ─────────────────────────────────────────────────────────
function _showFleetHUD() {
  const el = document.getElementById('hud-fleet');
  if (!el) return;
  if (_gameMode === MODES.ARCADE) { el.textContent = ''; return; }
  const parts = _playerFleet.map((t, i) => {
    const mark = i === _controlledIdx ? '▶' : (t.alive ? '◈' : '✖');
    const col  = i === _controlledIdx ? 'rgba(100,220,255,0.9)'
               : t.alive              ? 'rgba(160,220,130,0.7)'
               :                       'rgba(180,80,60,0.6)';
    return `<span style="color:${col}">${mark}</span>`;
  });
  el.innerHTML = parts.join(' ');
}

// ─── Mode-specific game start functions ───────────────────────────────────────
function startArcade() {
  _gameMode       = MODES.ARCADE;
  _arcadeClass    = _selIdx % 4;  // start at the class matching the chosen tank (0-3 within faction)
  _arcadeKills    = 0;
  _arcadeHeavyWave = 0;
  const faction = _selectedFaction();
  const startType = ARCADE_CLASSES[_arcadeClass][faction];
  reinitPlayer(startType);
  clearCraters(); _resetSmoke(); _resetArtillery();
  _lives = 2; _pendingRespawn = false;
  if (hudLives) hudLives.textContent = '';
  _drawLivesIcons();
  if (hudAmmo)  hudAmmo.style.display  = '';
  const fleetEl = document.getElementById('hud-fleet');
  if (fleetEl) fleetEl.textContent = '';
  game.start();
  game.totalWaves = 999; // arcade is endless
  spawnArcadeWave();
  if (hudPhase) hudPhase.textContent = 'ARCADE MODE';
  if (hudMode)  hudMode.textContent  = 'ARCADE MODE';
  _updateControlsHint();
  _demoActive = _demoEnabled;
  _demoAI     = _demoActive ? new AIController(player, player.position.x, player.position.z) : null;
}

function startAttrition() {
  _gameMode        = MODES.ATTRITION;
  _attritionBattle = 0;
  // Dispose the phantom Sherman (initial player or previous game's player)
  if (_playerFleet.length === 0) player.dispose(scene);
  _playerFleet     = [];
  _controlledIdx   = 0;
  clearCraters(); _resetSmoke(); _resetArtillery();
  _lives = 0; // no extra lives — fleet IS your lives
  if (hudLives) hudLives.textContent = '';
  if (hudAmmo)  hudAmmo.style.display  = 'none';
  game.start();
  game.totalWaves = 999;
  spawnAttritionBattle();
  if (hudPhase) hudPhase.textContent = 'ATTRITION MODE';
  if (hudMode)  hudMode.textContent  = 'ATTRITION MODE';
  _updateControlsHint();
  _demoActive = _demoEnabled;
  _demoAI     = _demoActive ? new AIController(player, player.position.x, player.position.z) : null;
}

function startStrategyPurchase() {
  _gameMode        = MODES.STRATEGY;
  _strategyLevel   = 0;
  _strategyBudget  = STRATEGY_BUDGETS[0];
  _playerFleet     = [];
  _purchaseFleet   = {};
  _purchaseSelIdx  = 0;
  for (const k of _strategyRoster()) _purchaseFleet[k] = 0;
  game.state = STATES.PURCHASE;
  updateOverlay();
}

function startStrategyBattle() {
  clearCraters(); _resetSmoke(); _resetArtillery();
  _lives = 0;
  if (hudLives) hudLives.textContent = '';
  if (hudAmmo)  hudAmmo.style.display  = 'none';
  game.startFresh();
  game.totalWaves = 999;
  spawnStrategyBattle();
  if (hudPhase) hudPhase.textContent = 'STRATEGY MODE';
  if (hudMode)  hudMode.textContent  = 'STRATEGY MODE';
  _updateControlsHint();
  _demoActive = _demoEnabled;
  _demoAI     = _demoActive ? new AIController(player, player.position.x, player.position.z) : null;
}

// ─── LAN duel functions ────────────────────────────────────────────────────────

// Arena obstacles — symmetric cover objects spawned for LAN duel
const _lanArenaObstacles = [];
let   _lanArenaObstacleMat = null;

function _addArenaObstacles() {
  _lanArenaObstacleMat = new THREE.MeshLambertMaterial({ color: 0x9A8C7E });
  // Symmetric across x=0 and z=0  [x, z, width, depth, height]
  const configs = [
    [  0,   0,  3, 10, 3.5],  // centre block — cuts line of fire between spawns
    [ 14,   0,  3,  4, 3.0],  // left flank wall
    [-14,   0,  3,  4, 3.0],  // right flank wall (mirror)
    [  8,  15,  6,  2, 2.5],  // forward cover near client spawn (+z)
    [ -8,  15,  6,  2, 2.5],
    [  8, -15,  6,  2, 2.5],  // forward cover near host spawn (-z)
    [ -8, -15,  6,  2, 2.5],
  ];
  for (const [x, z, w, d, h] of configs) {
    const geo  = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, _lanArenaObstacleMat);
    mesh.position.set(x, getAltitude(x, z) + h / 2, z);
    scene.add(mesh);
    _lanArenaObstacles.push(mesh);
  }
}

function _removeArenaObstacles() {
  for (const m of _lanArenaObstacles) { scene.remove(m); m.geometry.dispose(); }
  _lanArenaObstacles.length = 0;
  if (_lanArenaObstacleMat) { _lanArenaObstacleMat.dispose(); _lanArenaObstacleMat = null; }
}

function _cleanupLan() {
  _removeArenaObstacles();
  if (_lanNametag) _lanNametag.style.display = 'none';
  if (_lanNet)  { _lanNet.disconnect(); _lanNet = null; }
  if (_lanPeer) { _lanPeer.dispose(scene); _lanPeer = null; }
  _lanMode       = false;
  _lanGameActive = false;
  _lanStatus     = '';
  _lanEvents     = [];
  _lanGameResult = null;
  _lanEndTimer   = -1;
  _lanRtt        = 0;
  _lanLastSnapTs = 0;
  _lanPeerName   = '';
  _lanRoomCode   = '';
}

// Relay server URL — same host as the game, port 8765.
// Port 8765 is LAN-only (server is at a private IP; router does not forward it).
const _relayUrl = `ws://${location.hostname}:8765`;

async function startLanHost() {
  _lanMode       = true;
  _lanTankKey    = ALL_TANKS[_selIdx];
  _lanPlayerName = (overlayControls.querySelector('#lan-name-input')?.value.trim() || '').slice(0, 16);
  _lanRoomCode   = _genRoomCode();
  _lanStatus     = `Room ${_lanRoomCode} · Waiting for opponent…`;
  updateOverlay();

  _lanNet = new Net();
  _lanNet.onConnect     = () => { _lanNet.sendHello(_lanTankKey, _lanPlayerName); };
  _lanNet.onPeerHello   = (peerKey, peerName) => { _lanPeerName = peerName; _initLanGame(peerKey); };
  _lanNet.onDisconnect  = () => { _endLanSession('Opponent disconnected.'); };
  _lanNet.onServerError = msg => { _lanStatus = `Error: ${msg}`; updateOverlay(); };

  try {
    await _lanNet.host(_relayUrl, _lanRoomCode);
  } catch (e) {
    _lanStatus = `Cannot reach relay server (${e.message})`;
    updateOverlay();
  }
}

async function startLanClient(roomCode) {
  _lanMode       = true;
  _lanTankKey    = ALL_TANKS[_selIdx];
  _lanPlayerName = (overlayControls.querySelector('#lan-name-input')?.value.trim() || '').slice(0, 16);
  _lanRoomCode   = roomCode.toUpperCase().trim();
  _lanStatus     = `Joining room ${_lanRoomCode}…`;
  updateOverlay();

  _lanNet = new Net();
  _lanNet.onConnect     = () => { _lanNet.sendHello(_lanTankKey, _lanPlayerName); };
  _lanNet.onPeerHello   = (peerKey, peerName) => { _lanPeerName = peerName; _initLanGame(peerKey); };
  _lanNet.onDisconnect  = () => { _endLanSession('Host disconnected.'); };
  _lanNet.onServerError = msg => { _lanStatus = `Error: ${msg}`; updateOverlay(); };

  try {
    await _lanNet.join(_relayUrl, _lanRoomCode);
    _lanStatus = `Room ${_lanRoomCode} · Waiting for host…`;
    updateOverlay();
  } catch (e) {
    _lanStatus = `Cannot reach relay server (${e.message})`;
    updateOverlay();
  }
}

function _initLanGame(peerKey) {
  _removeArenaObstacles();  // clear any from a previous rematch
  clearCraters(); _resetSmoke(); _resetArtillery();
  for (const e of enemies) e.dispose(scene);
  enemies = []; aiControllers = [];
  for (const w of wingmen) w.dispose(scene);
  wingmen = []; wingmanAIs = [];

  // Place player (local tank)
  reinitPlayer(_lanTankKey);
  const spawnZ = _lanNet.isHost() ? -30 : 30;
  player.position.set(0, getAltitude(0, spawnZ) + 0.1, spawnZ);
  player.heading = _lanNet.isHost() ? 0 : Math.PI;  // face centre

  // Place peer tank (remote)
  _lanPeerTankKey = peerKey;
  if (_lanPeer) { _lanPeer.dispose(scene); }
  const peerZ = _lanNet.isHost() ? 30 : -30;
  _lanPeer = new Tank(scene, peerKey, _lanNet.isHost());
  _lanPeer.position.set(0, getAltitude(0, peerZ) + 0.1, peerZ);
  _lanPeer.heading = _lanNet.isHost() ? Math.PI : 0;

  allTanks = [player, _lanPeer];
  combat.dispose();
  _addArenaObstacles();
  _lanGameActive  = true;
  _lanBroadTimer  = 0;
  _lanEvents      = [];
  _lanGameResult  = null;
  _lanEndTimer    = -1;
  _lanRtt         = 0;
  _lanLastSnapTs  = 0;
  _demoActive     = false;
  _demoAI         = null;

  game.start();
  if (hudMode)  hudMode.textContent  = 'LAN DUEL';
  if (hudPhase) hudPhase.textContent = 'LAN DUEL';
  _updateControlsHint();
  updateOverlay();
}

function _endLanGame(won) {
  if (_lanGameResult !== null) return;  // guard against double-trigger
  _lanGameResult = won ? 'h' : 'c';
  if (_lanNet && _lanNet.isHost()) {
    // Host: keep broadcasting res for 500 ms so UDP drops can't strand the client
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

// LAN game loop — called from animate() when _lanMode && _lanGameActive
function _runLanFrame(dt, now) {
  if (_lanNet.isHost()) {
    // ── Host: drive own tank, apply client input to peer ───────────────────────
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

    if (_lanPeer && _lanPeer.alive && _lanNet.clientInput) {
      const ci = _lanNet.clientInput;
      _lanPeer.update(dt, ci);
      if (ci.fire || ci.fireOnce) {
        const tip = combat.fire(_lanPeer);
        if (tip) {
          particles.muzzleFlash(tip.x, tip.y, tip.z);
          _lanEvents.push({ t: 'fl', x: tip.x, y: tip.y, z: tip.z });
        }
      }
    }

    // Combat: shells vs both tanks; collect events for client
    const impacts = combat.update(dt, allTanks);
    for (const imp of impacts) {
      if (imp.penetrated) {
        particles.explosion(imp.x, imp.y, imp.z);
        _lanEvents.push({ t: 'ex', x: imp.x, y: imp.y, z: imp.z });
      } else {
        particles.ricochet(imp.x, imp.y, imp.z);
        _lanEvents.push({ t: 'rc', x: imp.x, y: imp.y, z: imp.z });
      }
      if (imp.tank && !imp.tank.alive) imp.tank.setDestroyed();
    }

    // Broadcast snapshot at LAN_SNAP_HZ
    _lanBroadTimer -= dt;
    if (_lanBroadTimer <= 0) {
      _lanBroadTimer = 1 / LAN_SNAP_HZ;
      // RTT measurement: compute from client's echoed timestamp
      if (_lanNet.clientEchoTs) {
        _lanRtt = Math.round(Date.now() - _lanNet.clientEchoTs);
        _lanNet.clientEchoTs = 0;
      }
      _lanNet.sendSnapshot({
        p:   player.getState(),
        c:   _lanPeer ? _lanPeer.getState() : null,
        ev:  _lanEvents.splice(0),  // consume all pending events
        res: _lanGameResult,
        rtt: _lanRtt,
        ts:  Date.now(),
      });
    }

    // End condition (host authoritative)
    if (_lanGameResult === null && _lanPeer && (!player.alive || !_lanPeer.alive)) {
      _endLanGame(player.alive);
    }

    // Wind-down: keep broadcasting res until timer expires, then transition
    if (_lanEndTimer > 0) {
      _lanEndTimer -= dt;
      _lanBroadTimer -= dt;
      if (_lanBroadTimer <= 0) {
        _lanBroadTimer = 1 / LAN_SNAP_HZ;
        _lanNet.sendSnapshot({
          p: player.getState(), c: _lanPeer ? _lanPeer.getState() : null,
          ev: [], ts: Date.now(), rtt: _lanRtt, res: _lanGameResult,
        });
      }
      if (_lanEndTimer <= 0) {
        _lanGameActive = false;
        game.state = _lanGameResult === 'h' ? STATES.VICTORY : STATES.GAME_OVER;
        updateOverlay();
        return;
      }
    }

  } else {
    // ── Client: local prediction + send input + apply host snapshot ────────────

    // Prediction: run local physics every frame for smooth own-tank movement
    if (player.alive) player.update(dt, input);

    // Send input with echo timestamp for host RTT measurement
    _lanNet.sendInput(input, _lanLastSnapTs);

    const snap = _lanNet.consumeSnapshot();
    if (snap) {
      _lanLastSnapTs = snap.ts ?? 0;

      // Receive RTT measured by host
      if (snap.rtt !== undefined) _lanRtt = snap.rtt;

      // Play shot effects sent by host
      if (snap.ev) {
        for (const ev of snap.ev) {
          if      (ev.t === 'fl') particles.muzzleFlash(ev.x, ev.y, ev.z);
          else if (ev.t === 'ex') particles.explosion(ev.x, ev.y, ev.z);
          else if (ev.t === 'rc') particles.ricochet(ev.x, ev.y, ev.z);
        }
      }

      // Authoritative correction for own tank (snap to host state)
      if (snap.c) {
        const wasAlive = player.alive;
        player.applyState(snap.c);
        if (wasAlive && !player.alive) player.setDestroyed();
      }

      // Apply remote (host) tank state
      if (snap.p && _lanPeer) {
        const wasAlive = _lanPeer.alive;
        _lanPeer.applyState(snap.p);
        if (wasAlive && !_lanPeer.alive) _lanPeer.setDestroyed();
      }

      // End condition: host authoritative via res field
      if (snap.res) _endLanGame(snap.res === 'c');
    }

    if (player.alive) player.updateCamera(camera, dt);
  }

  particles.update(dt);

  // ── LAN peer name tag ─────────────────────────────────────────────────────────
  if (_lanPeer && _lanNametag) {
    if (!_lanPeer.alive) {
      _lanNametag.style.display = 'none';
    } else {
      // Project peer tank's world position to screen
      _lanNametagPos.copy(_lanPeer.position);
      _lanNametagPos.y += 4.5 * _lanPeer.def.modelScale;
      _lanNametagPos.project(camera);
      const sw = renderer.domElement.clientWidth;
      const sh = renderer.domElement.clientHeight;
      const sx = (_lanNametagPos.x + 1) * 0.5 * sw;
      const sy = (-_lanNametagPos.y + 1) * 0.5 * sh;
      // Only show when in front of camera and on-screen
      if (_lanNametagPos.z < 1 && sx > 0 && sx < sw && sy > 0 && sy < sh) {
        const hpPct = Math.max(0, Math.round(_lanPeer.hp / _lanPeer.maxHp * 100));
        const nameLabel = _lanPeerName ? `<span class="nt-name">${_lanPeerName}</span>` : '';
        _lanNametag.innerHTML =
          `${nameLabel}${_lanPeer.def.name}<span class="nt-hp"><span class="nt-hp-fill" style="width:${hpPct}%"></span></span>`;
        _lanNametag.style.display = 'block';
        _lanNametag.style.left = `${sx}px`;
        _lanNametag.style.top  = `${sy}px`;
      } else {
        _lanNametag.style.display = 'none';
      }
    }
  }

  // ── LAN HUD (~2 Hz) ──────────────────────────────────────────────────────────
  fpsCount++;
  if (now - fpsTime >= 500) {
    const fps = Math.round(fpsCount / ((now - fpsTime) / 1000));
    fpsCount = 0; fpsTime = now;
    if (hudFps)     hudFps.textContent  = `${fps}`;
    if (hudMode)    hudMode.textContent = `LAN DUEL  ·  ${_lanRtt}ms`;
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

function lanLobbyHtml() {
  return `
    <div class="lan-lobby">
      <div class="lan-name-row">
        <label class="lan-name-label" for="lan-name-input">Your name</label>
        <input id="lan-name-input" class="lan-input lan-name-input" type="text" maxlength="16"
               placeholder="Player" value="${_lanPlayerName}" />
      </div>
      <div class="lan-section">
        <div class="lan-section-title">Host a game</div>
        <div class="lan-desc">Click Host Game — a room code is generated. Share it with your opponent.</div>
        <button id="lan-host-btn" class="lan-btn">Host Game</button>
      </div>
      <div class="lan-divider">— or —</div>
      <div class="lan-section">
        <div class="lan-section-title">Join a game</div>
        <div class="lan-scan-row">
          <button id="lan-scan-btn" class="lan-btn lan-btn-sm">Find games</button>
          <span id="lan-scan-status" class="lan-scan-status"></span>
        </div>
        <div id="lan-scan-results" class="lan-scan-results"></div>
        <div class="lan-desc">Or enter the room code:</div>
        <div class="lan-join-row">
          <input id="lan-code-input" class="lan-input lan-code-input" type="text" maxlength="4"
                 placeholder="CODE" value="${_lanRoomCode}" />
          <button id="lan-join-btn" class="lan-btn">Join</button>
        </div>
      </div>
      <div class="lan-status">${_lanStatus}</div>
      <div class="lan-back"><button id="lan-back-btn" class="lan-back-btn">Back to menu</button></div>
    </div>
  `;
}

/** Generate a random 4-character room code (no ambiguous chars O/0/I/1). */
function _genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── Between-battle advance ────────────────────────────────────────────────────
function advanceAttritionBattle() {
  _attritionBattle++;
  clearCraters(); _resetSmoke(); _resetArtillery();
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
  // Dispose old fleet
  for (const t of _playerFleet) t.dispose(scene);
  _playerFleet = [];
  // Go back to purchase screen
  _purchaseFleet = {};
  _purchaseSelIdx = 0;
  for (const k of _strategyRoster()) _purchaseFleet[k] = 0;
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
const hudSmoke   = document.getElementById('hud-smoke');
const hudAmmo    = document.getElementById('hud-ammo');
const hudArty    = document.getElementById('hud-arty');
const hudLives   = document.getElementById('hud-lives');

// ─── Overlay elements ─────────────────────────────────────────────────────────
const overlay         = document.getElementById('overlay');
const overlayTitle    = document.getElementById('overlay-title');
const overlaySub      = document.getElementById('overlay-sub');
const overlayControls = document.getElementById('overlay-controls');
const overlayScore    = document.getElementById('overlay-score');
const overlayHint     = document.getElementById('overlay-hint');
const hudEdgeWarning  = document.getElementById('hud-edge-warning');
const hudHitIndicator = document.getElementById('hud-hit-indicator');
const hudSight        = document.getElementById('hud-sight');
const hudDamageFlash  = document.getElementById('hud-damage-flash');
const hudTarget       = document.getElementById('hud-target');
const hudTargetName   = document.getElementById('hud-target-name');
const hudTargetBar    = document.getElementById('hud-target-bar');
let _hitIndTimer = 0;

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
}

const diffSlider = document.getElementById('diff-slider');
if (diffSlider) {
  diffSlider.addEventListener('input', () => setDifficulty(DIFF_LEVELS[diffSlider.value]));
}
setDifficulty('normal');   // default: Normal

// ─── Settings panel wiring ────────────────────────────────────────────────────
const cbSimple    = document.getElementById('cb-simple-controls');
const hudControls = document.getElementById('hud-controls');

function _updateControlsHint() {
  const fleet     = _gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY;
  const tabAction = fleet ? 'switch tank' : 'ammo (AP/HE)';

  // Right HUD panel: structured two-column rows
  if (hudControls) {
    const rows = input.simpleMode
      ? [['W/S',   'fwd / back'], ['A/D',   'turn'],      ['Q/E',   'turret'],
         ['Space', 'fire'],       ['Tab',   tabAction],   ['G',     'smoke'],
         ['C',     'artillery'],  ['Esc/P', 'pause'],     ['V',     'gunsight']]
      : [['H/N',   'left track fwd/rev'], ['K/M',   'right track fwd/rev'],
         ['Q/E',   'turret'],             ['Space', 'fire'],
         ['Tab',   tabAction],            ['G',     'smoke'],
         ['C',     'artillery'],          ['P',     'pause'],
         ['V',     'gunsight']];
    hudControls.innerHTML = rows
      .map(([k, a]) => `<div class="hir-row"><span class="hir-key">${k}</span><span class="hir-action">${a}</span></div>`)
      .join('');
  }

  // Settings panel reference — kept in sync
  const tabDesc = fleet ? 'Tab \u00B7 switch tank' : 'Tab \u00B7 ammo (AP/HE)';
  const ref = document.getElementById('settings-ctrl-ref');
  if (!ref) return;
  if (input.simpleMode) {
    ref.innerHTML =
      `<kbd>W</kbd>/<kbd>S</kbd> forward/back &nbsp; <kbd>A</kbd>/<kbd>D</kbd> turn<br>` +
      `<kbd>Q</kbd>/<kbd>E</kbd> turret left/right &nbsp; <kbd>Space</kbd>/<kbd>F</kbd> fire<br>` +
      `${tabDesc} &nbsp; <kbd>V</kbd> gun sight<br>` +
      `<kbd>G</kbd> smoke &nbsp; <kbd>C</kbd> artillery &nbsp; <kbd>Esc</kbd>/<kbd>P</kbd> pause`;
  } else {
    ref.innerHTML =
      `<kbd>H</kbd>/<kbd>N</kbd> left track fwd/rev &nbsp; <kbd>K</kbd>/<kbd>M</kbd> right track fwd/rev<br>` +
      `<kbd>Q</kbd>/<kbd>E</kbd> turret left/right &nbsp; <kbd>Space</kbd>/<kbd>F</kbd> fire<br>` +
      `${tabDesc} &nbsp; <kbd>V</kbd> gun sight<br>` +
      `<kbd>G</kbd> smoke &nbsp; <kbd>C</kbd> artillery &nbsp; <kbd>P</kbd> pause`;
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
  cbAdvancedInfo.addEventListener('change', () => _applyAdvancedHud(cbAdvancedInfo.checked));
}

// Simple controls are on by default
cbSimple.checked = true;
input.simpleMode = true;

cbSimple.addEventListener('change', () => {
  input.simpleMode = cbSimple.checked;
  _updateControlsHint();
  updateOverlay();
});

// Aim assist (auto-rotate turret) — applies in simple mode only
let _aimAssist = true;
const cbAimAssist = document.getElementById('cb-aim-assist');
if (cbAimAssist) {
  cbAimAssist.checked = true;
  cbAimAssist.addEventListener('change', () => { _aimAssist = cbAimAssist.checked; });
}

// ─── Mercenaries toggle ───────────────────────────────────────────────────────
let _mercsEnabled = false;
const cbMercs = document.getElementById('cb-mercenaries');
if (cbMercs) {
  cbMercs.checked = false;
  cbMercs.addEventListener('change', () => {
    _mercsEnabled = cbMercs.checked;
    if (!_mercsEnabled && _faction === 'mercenary') _setFaction('american');
    updateOverlay();
  });
}

// ─── LAN enabled toggle ───────────────────────────────────────────────────────
let _lanEnabled = false;
const cbLan = document.getElementById('cb-lan');
if (cbLan) {
  cbLan.checked = false;
  cbLan.addEventListener('change', () => {
    _lanEnabled = cbLan.checked;
    updateOverlay();   // re-render menu to show/hide LAN Duel option
  });
}

// ─── LAN networking state ─────────────────────────────────────────────────────
let _lanMode       = false;  // true while a LAN duel is set up or in progress
let _lanNet        = null;   // Net instance
let _lanPeer       = null;   // Tank controlled by the remote player
let _lanBroadTimer = 0;      // countdown to next broadcast (host only)
let _lanGameActive = false;  // true once both tanks are spawned and game is running
let _lanTankKey    = null;   // this player's selected tank key for LAN
let _lanStatus     = '';     // display string for lobby screen
let _lanEvents      = [];    // muzzle/explosion events pending next broadcast (host)
let _lanGameResult  = null;  // null | 'h' (host won) | 'c' (client won)
let _lanEndTimer    = -1;    // host: seconds remaining in wind-down broadcast (-1 = inactive)
let _lanRtt         = 0;     // round-trip time in ms (from host measurement)
let _lanLastSnapTs  = 0;     // client: ts of last received snapshot (echoed to host)
let _lanPeerTankKey  = null;  // peer's tank key — saved for rematch
let _lanPlayerName   = '';    // this player's chosen name
let _lanPeerName     = '';    // peer's name (received in Hello)
let _lanRoomCode     = '';    // 4-char room code for this session
const _lanNametag    = document.getElementById('lan-nametag');
const _lanNametagPos = new THREE.Vector3();  // reused for screen projection

// ─── Demo mode ────────────────────────────────────────────────────────────────
// When enabled in Settings and no player input has been received, the AI drives
// the player tank. First actual input from the player disables demo for the session.
let _demoEnabled = true;
let _demoActive  = false;   // true = AI is currently driving the player
let _demoAI      = null;    // AIController instance for the player (created on game start)

const cbDemo = document.getElementById('cb-demo');
if (cbDemo) {
  cbDemo.checked = true;
  cbDemo.addEventListener('change', () => { _demoEnabled = cbDemo.checked; });
}

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
  const fleet = _gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY;
  const tabDesc = fleet ? 'switch tank' : 'switch ammo  (AP / HE)';

  if (input.simpleMode) {
    return [
      row('W / S',     'forward / backward'),
      row('A / D',     'turn left / right'),
      row('Q / E',     'turret left / right'),
      row('Space / F', 'fire'),
      row('Tab',       tabDesc),
      row('G',         'smoke grenade  (3 / wave)'),
      row('C',         'artillery support  (2 / wave)'),
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
    row('G',         'smoke grenade  (3 / wave)'),
    row('C',         'artillery support  (2 / wave)'),
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
  const reloadDisplay = (def.reloadTime * PLAYER_RELOAD_MULT).toFixed(1);
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
function reinitPlayer(type) {
  player.dispose(scene);
  player = new Tank(scene, type);
  player.reloadTime      = player.reloadTime * PLAYER_RELOAD_MULT;
  player.reloadTimer     = player.reloadTime;
  player.damageMult      = DIFFICULTY.playerDmgMult;
  player.turretSpeedMult = 1.05;
  if (hudName)    hudName.textContent    = player.def.name;
  if (hudFaction) hudFaction.textContent = _factionLabel(player.def.faction).toUpperCase();
}

// ─── Combined menu: 2-column vehicle + battle mode selector ──────────────────
function menuScreenHtml() {
  const key = ALL_TANKS[_selIdx];
  const def = CONFIG.TANK_DEFS[key];
  function bar(val, max) {
    const n = Math.min(8, Math.max(0, Math.round(val / max * 8)));
    return '\u25A0'.repeat(n) + '\u25A1'.repeat(8 - n);
  }
  const arrowL = _selIdx > 0 ? '\u25C4' : '\u00A0';
  const arrowR = _selIdx < ALL_TANKS.length - 1 ? '\u25BA' : '\u00A0';
  const reloadDisplay = (def.reloadTime * PLAYER_RELOAD_MULT).toFixed(1);
  const reloadBar = bar(5 - parseFloat(reloadDisplay), 5);

  let html = '<div class="menu-combined">';

  // ── Left column: army / faction selector ──────────────────────────────────
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

  // ── Middle column: tank selector ──────────────────────────────────────────
  html += '<div class="menu-col">';
  html += '<div class="menu-section-label">VEHICLE</div>';
  html += '<div class="ts-nav">';
  html += `<span class="ts-arrow">${arrowL}</span>`;
  html += `<span class="ts-name">${def.name}</span>`;
  html += `<span class="ts-arrow">${arrowR}</span>`;
  html += '</div>';
  html += '<div class="ts-stats">';
  html += `<div class="ts-row"><span class="ts-label">Armour</span><span class="ts-bar">${bar(def.frontArmour, 100)}</span><span class="ts-val">${def.frontArmour}</span></div>`;
  html += `<div class="ts-row"><span class="ts-label">Firepower</span><span class="ts-bar">${bar(def.firepower, 100)}</span><span class="ts-val">${def.firepower}</span></div>`;
  html += `<div class="ts-row"><span class="ts-label">Speed</span><span class="ts-bar">${bar(def.maxSpeed, 56)}</span><span class="ts-val">${def.maxSpeed} km/h</span></div>`;
  html += `<div class="ts-row"><span class="ts-label">Reload</span><span class="ts-bar">${reloadBar}</span><span class="ts-val">${reloadDisplay}s</span></div>`;
  html += '</div>';
  html += `<div class="ts-counter">${_selIdx + 1} / ${ALL_TANKS.length}</div>`;
  html += '</div>';

  // ── Right column: mode selector ───────────────────────────────────────────
  html += '<div class="menu-col">';
  html += '<div class="menu-section-label">BATTLE MODE</div>';
  html += '<div class="mode-select">';
  const modeNames = ['Arcade', 'Attrition', 'Strategy', ...(_lanEnabled ? ['LAN Duel'] : [])];
  const modeDescs = [
    'Endless waves \u00B7 Solo \u00B7 Tank upgrades by kills \u00B7 3 lives',
    'Fixed fleet of 5 \u00B7 Permanent losses \u00B7 Escalating enemy',
    'Budget purchase \u00B7 Objective capture \u00B7 AI buys too',
    ...(_lanEnabled ? ['1 vs 1 \u00B7 Local network \u00B7 Pick any tank'] : []),
  ];
  // Clamp selection in case LAN was just disabled while on index 3
  if (_modeSelIdx >= modeNames.length) _modeSelIdx = modeNames.length - 1;
  for (let i = 0; i < modeNames.length; i++) {
    const sel = i === _modeSelIdx;
    html += `<div class="mode-opt${sel ? ' mode-selected' : ''}" data-mode-idx="${i}">`;
    html += `<div class="mode-name">${sel ? '\u25B6 ' : ''}${modeNames[i]}</div>`;
    html += `<div class="mode-desc">${modeDescs[i]}</div>`;
    html += '</div>';
  }
  html += '</div>';
  html += '</div>';

  html += '</div>';
  return html;
}

// ─── Mode selection HTML (kept for reference) ─────────────────────────────────
function modeSelectHtml() {
  const descs = [
    'Endless waves · Tank upgrades by kills · 3 lives · Solo',
    'Fixed fleet of 5 · Permanent losses · Escalating enemy · Tab = switch tank',
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

  let html = `<div class="purchase-screen">`;
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
    const n      = _purchaseFleet[key] ?? 0;
    const sel    = i === _purchaseSelIdx;
    const header = _factionHeaderOf(key);
    if (header !== _lastHeader) {
      html += `<div class="purchase-faction-header">${header}</div>`;
      _lastHeader = header;
    }
    html += `<div class="purchase-row${sel ? ' purchase-selected' : ''}">`;
    html += `<span class="pur-name">${def.name}</span>`;
    html += `<span class="pur-stats">${bar(def.frontArmour, 100)} ARM  ${bar(def.firepower, 100)} FP  ${bar(def.maxSpeed, 56)} SPD</span>`;
    html += `<span class="pur-cost">${TANK_COSTS[key]} pts</span>`;
    html += `<span class="pur-qty">${sel ? '◄ ' : '  '}${n}${sel ? ' ►' : '  '}</span>`;
    html += `</div>`;
  }

  html += `</div>`;
  html += `<div class="purchase-hint">▲/▼ select  ·  ◄/► qty  ·  Enter = START BATTLE</div>`;
  if (remaining < 0) html += `<div class="purchase-error">⚠ Over budget — reduce fleet</div>`;
  if (total === 0)   html += `<div class="purchase-error">⚠ Buy at least one tank</div>`;
  html += `</div>`;
  return html;
}

// ─── Overlay updater ─────────────────────────────────────────────────────────
function updateOverlay() {
  const s = game.state;

  // ← GAMES portal button: visible on title and end screens only
  const gamesBack = document.getElementById('games-back');
  if (gamesBack) {
    const showBtn = s === STATES.MENU || s === STATES.GAME_OVER || s === STATES.VICTORY;
    gamesBack.style.display = showBtn ? 'block' : 'none';
  }

  // Hold GAME_OVER screen until death camera has finished
  if (s === STATES.GAME_OVER && _deathCamTimer >= 0) return;

  if (s === STATES.PLAYING) {
    overlay.className = 'overlay-hidden';
    return;
  }

  overlay.className = 'overlay-visible';

  if (s === STATES.LAN_LOBBY) {
    overlayTitle.textContent = 'LAN DUEL';
    overlaySub.textContent   = '1 vs 1 on your local network';
    overlayScore.textContent = '';
    overlayHint.textContent  = '';
    if (overlayControls) {
      overlayControls.innerHTML = lanLobbyHtml();
      const btnHost = overlayControls.querySelector('#lan-host-btn');
      const btnJoin = overlayControls.querySelector('#lan-join-btn');
      const btnBack = overlayControls.querySelector('#lan-back-btn');
      const btnScan = overlayControls.querySelector('#lan-scan-btn');
      if (btnHost) btnHost.addEventListener('click', () => startLanHost());
      if (btnJoin) btnJoin.addEventListener('click', () => {
        const code = overlayControls.querySelector('#lan-code-input')?.value.trim() || '';
        if (!code) { _lanStatus = 'Enter the 4-character room code.'; updateOverlay(); return; }
        startLanClient(code);
      });
      if (btnBack) btnBack.addEventListener('click', () => {
        _cleanupLan();
        game.state = STATES.MENU;
        updateOverlay();
      });
      if (btnScan) btnScan.addEventListener('click', async () => {
        const scanStatus  = overlayControls.querySelector('#lan-scan-status');
        const scanResults = overlayControls.querySelector('#lan-scan-results');
        btnScan.disabled = true;
        if (scanStatus)  scanStatus.textContent = 'Looking…';
        if (scanResults) scanResults.innerHTML  = '';
        try {
          const r    = await fetch(`http://${location.hostname}:8765/discover`);
          const data = await r.json();
          const waitingRooms = (data.rooms || []);
          btnScan.disabled = false;
          if (waitingRooms.length === 0) {
            if (scanStatus) scanStatus.textContent = 'No games waiting.';
          } else {
            if (scanStatus) scanStatus.textContent =
              `${waitingRooms.length} game${waitingRooms.length > 1 ? 's' : ''} waiting:`;
            if (scanResults) {
              scanResults.innerHTML = waitingRooms.map(g =>
                `<button class="lan-scan-result lan-scan-result-ready" data-code="${g.code}">` +
                `<span class="scan-code">${g.code}</span>` +
                `</button>`
              ).join('');
              scanResults.querySelectorAll('.lan-scan-result').forEach(el => {
                el.addEventListener('click', () => {
                  const codeInput = overlayControls.querySelector('#lan-code-input');
                  if (codeInput) codeInput.value = el.dataset.code;
                });
              });
            }
          }
        } catch {
          btnScan.disabled = false;
          if (scanStatus) scanStatus.textContent = 'Relay server not reachable.';
        }
      });
    }
    return;
  }

  if (s === STATES.PURCHASE) {
    overlayTitle.textContent = 'PURCHASE FLEET';
    overlaySub.textContent   = `Level ${_strategyLevel + 1}  ·  Budget: ${_strategyBudget} pts`;
    if (overlayControls) overlayControls.innerHTML = purchaseHtml();
    overlayScore.textContent = '';
    overlayHint.textContent  = '';
    return;
  }

  if (s === STATES.MENU) {
    overlayTitle.textContent = 'CONQUEROR';
    overlaySub.textContent   = 'Select vehicle and battle mode';
    if (overlayControls) {
      overlayControls.innerHTML = menuScreenHtml();
      // Clicking a faction card switches army and resets vehicle list
      overlayControls.querySelectorAll('.faction-opt').forEach(el => {
        el.addEventListener('click', () => _setFaction(el.dataset.faction));
      });
      // Clicking a mode card selects it; Enter/Space starts
      overlayControls.querySelectorAll('.mode-opt').forEach((el, i) => {
        el.addEventListener('click', () => { _modeSelIdx = i; updateOverlay(); });
      });
    }
    overlayScore.textContent = '';
    overlayHint.textContent  = '\u25C4 / \u25BA  Vehicle   \u00B7   \u25B2 / \u25BC  Mode   \u00B7   Enter  Start';
    return;
  }

  if (overlayControls) overlayControls.innerHTML = '';

  if (s === STATES.PAUSED) {
    overlayTitle.textContent = 'PAUSED';
    overlaySub.textContent   = '';
    overlayScore.textContent = `Score: ${game.score}  ·  Kills: ${game.kills}`;
    overlayHint.textContent  = 'Press P to resume';

  } else if (s === STATES.WAVE_COMPLETE) {
    overlayTitle.textContent = `WAVE ${game.wave} CLEARED`;
    overlaySub.textContent   = `Prepare for wave ${game.wave + 1} of ${game.totalWaves}`;
    overlayScore.textContent = `Score: ${game.score}  ·  +30 HP repair`;
    overlayHint.textContent  = 'Press R to continue';

  } else if (s === STATES.BATTLE_COMPLETE) {
    const modeLabel = _gameMode === MODES.ATTRITION ? 'Battle' : 'Objective';
    overlayTitle.textContent = `${modeLabel.toUpperCase()} WON`;
    if (_gameMode === MODES.ATTRITION) {
      const survivors = _playerFleet.filter(t => t.alive).length;
      overlaySub.textContent = `Battle ${_attritionBattle + 1} cleared  ·  ${survivors} / ${_playerFleet.length} tanks surviving`;
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
    } else if (_gameMode === MODES.ARCADE) {
      overlayTitle.textContent = 'TANK DESTROYED';
      overlaySub.textContent   = `Class ${_arcadeClass + 1}  ·  Kills: ${game.kills}`;
      overlayScore.textContent = `Final score: ${game.score}  ·  Total kills: ${game.kills}`;
    } else {
      overlayTitle.textContent = 'FLEET DESTROYED';
      overlaySub.textContent   = _gameMode === MODES.ATTRITION
        ? `Battle ${_attritionBattle + 1}  ·  Fleet wiped out`
        : `Level ${_strategyLevel + 1}  ·  Fleet wiped out`;
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
      overlaySub.textContent   = 'You destroyed your opponent';
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
  const opp = _lanPeerName || 'Opponent';
  return `
    <div class="lan-lobby">
      <div class="lan-status" style="font-size:13px;color:${won ? 'rgba(120,255,120,0.85)' : 'rgba(255,100,80,0.85)'}">
        ${won ? `● ${opp} destroyed` : `● Destroyed by ${opp}`}
      </div>
      <div style="display:flex;gap:10px;margin-top:8px;">
        <button id="lan-rematch-btn" class="lan-btn">Rematch</button>
        <button id="lan-menu-btn"    class="lan-btn">Main Menu</button>
      </div>
    </div>`;
}

function _wireLanEndButtons() {
  const rematch = overlayControls.querySelector('#lan-rematch-btn');
  const menu    = overlayControls.querySelector('#lan-menu-btn');
  if (rematch) rematch.addEventListener('click', () => {
    if (_lanNet && _lanNet.connected && _lanPeerTankKey) {
      _initLanGame(_lanPeerTankKey);
    }
  });
  if (menu) menu.addEventListener('click', () => {
    _cleanupLan();
    game.state = STATES.MENU;
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
        _purchaseFleet[key] = (_purchaseFleet[key] ?? 0) + 1;
        updateOverlay();
      }
    } else if (e.code === 'ArrowLeft') {
      const key = roster[_purchaseSelIdx];
      if ((_purchaseFleet[key] ?? 0) > 0) {
        _purchaseFleet[key]--;
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
      _selIdx = Math.min(ALL_TANKS.length - 1, _selIdx + 1);
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
      // Partial HP repair between waves
      player.hp = Math.min(player.maxHp, player.hp + 30);
      _prevHpTier = player.hp < 12 ? 3 : player.hp < 25 ? 2 : player.hp < 50 ? 1 : 0;
      if (_damageSmoke && player.hp >= 50) { _damageSmoke.active = false; _damageSmoke = null; }
      clearCraters(); _resetSmoke(); _resetArtillery();
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

  // Alive enemies
  ctx.fillStyle = 'rgba(210, 60, 35, 0.90)';
  for (const e of enemies) {
    if (!e.alive) continue;
    const p = toMM(e.position.x, e.position.z);
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
  }

  // Wingmen — cyan dots
  ctx.fillStyle = 'rgba(60, 210, 255, 0.90)';
  for (const w of wingmen) {
    if (!w.alive) continue;
    const p = toMM(w.position.x, w.position.z);
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
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

  // Player dot (drawn on top of the FOV V)
  ctx.fillStyle = player.alive ? 'rgba(75, 215, 95, 0.95)' : 'rgba(190, 185, 100, 0.65)';
  ctx.beginPath(); ctx.arc(pp.x, pp.y, 5, 0, Math.PI * 2); ctx.fill();

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
// Called whenever a tank is killed (direct hit or HE splash). Handles hull
// destruction visual, persistent fire, and player death-camera trigger.
function _processTankDeath(tank, killer) {
  tank.setDestroyed();
  // Char hull to dark blackened wreck (vertex-coloured meshes only; skip shared gun barrel material)
  tank.mesh.traverse(obj => {
    if (obj.isMesh && obj.material && obj.material.color && obj.material.vertexColors) {
      obj.material.color.setHex(0x1A1208);
    }
  });
  const s = tank.def.modelScale;
  particles.addBurner(tank.position.x, tank.position.y + 1.1 * s, tank.position.z);
  if (tank === player) {
    _exitSightMode();
    _killer = killer ?? null;
    _deathCamAngle = _killer
      ? Math.atan2(
          _killer.position.x - player.position.x,
          _killer.position.z - player.position.z,
        ) + Math.PI
      : 0;

    if (_gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY) {
      // Fleet mode: auto-switch to next alive fleet tank, no lives/respawn
      _deathCamTimer = 1.5;  // brief death cam then auto-switch
      if (_damageSmoke) { _damageSmoke.active = false; _damageSmoke = null; }
      _showFleetHUD();
    } else {
      // Arcade mode: use lives system
      _deathCamTimer = 0;
      if (_damageSmoke) { _damageSmoke.active = false; _damageSmoke = null; }
      if (_lives > 0) {
        _lives--;
        _pendingRespawn = true;
        if (hudLives) hudLives.textContent = '♦'.repeat(_lives);
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

// ─── Supply crate functions ────────────────────────────────────────────────────
function _clearCrates() {
  for (const c of _crates) {
    if (c.mesh) { scene.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh.material.dispose(); }
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
      new THREE.MeshLambertMaterial({ color: ct.color }),
    );
    mesh.position.set(x, y, z);
    scene.add(mesh);
    _crates.push({ x, z, y, type: ct.type, mesh, alive: true, phase: Math.random() * Math.PI * 2 });
  }
}

function _collectCrate(c) {
  c.alive = false;
  scene.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh.material.dispose(); c.mesh = null;
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
    c.mesh.rotation.y += dt * 1.2;
    c.mesh.position.y = c.y + Math.sin(c.phase) * 0.22 + 0.22;
    const dx = player.position.x - c.x;
    const dz = player.position.z - c.z;
    if (dx * dx + dz * dz < CRATE_COLLECT_R * CRATE_COLLECT_R) _collectCrate(c);
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
  camera.fov = SIGHT_FOV;
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
  const pauseKey = input.pause;
  if (pauseKey && !prevPauseKey &&
      (game.state === STATES.PLAYING || game.state === STATES.PAUSED)) {
    game.togglePause();
    updateOverlay();
  }
  prevPauseKey = pauseKey;

  // ── Gun-sight toggle (V key) ──────────────────────────────────────────────────
  if (game.state === STATES.PLAYING && player.alive && input.sightToggle) {
    if (_sightMode) _exitSightMode(); else _enterSightMode();
  }

  // ── Ammo type toggle / tank switch (Tab key) ────────────────────────────────
  if (game.state === STATES.PLAYING && player.alive && input.ammoSwitch) {
    if (_gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY) {
      // Tab = cycle to next alive fleet tank
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
        // Fleet mode: switch to next alive fleet tank (or game over handled by end conditions)
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
    const isMenu = game.state === STATES.MENU;
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
    // ── Demo mode: AI drives the player until any input is detected ─────────────
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

    // ── Aim assist — nudge player turret toward nearest enemy in range ──────────
    // Disabled in sight mode (mouse controls directly) and when player is manually
    // rotating the turret with Q/E (manual input always wins).
    const _manualTurret = input.turretLeft || input.turretRight;
    let assistTarget = null;
    let assistDist   = (!_sightMode && !_manualTurret && _aimAssist && input.simpleMode) ? ASSIST_RANGE : 0;
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
      player.turretYaw += yawDiff * Math.min(ASSIST_RATE * dt, 1);
      // Ballistic elevation to compensate for height difference
      const horiz = Math.sqrt(dx * dx + dz * dz);
      player.gunElevation = ballisticElevation(horiz, assistTarget.position.y - player.position.y);
    } else if (!_sightMode) {
      player.gunElevation = 0.06;
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

  // ── Road speed bonus — update all alive tanks ────────────────────────────────
  for (const t of allTanks) {
    if (t.alive) t.roadBonus = _isOnRoad(t.position.x, t.position.z);
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
    wingmanAIs[i].update(dt, enemies, combat, particles);
    wingmen[i].update(dt, { skipAccel: true, turretLeft:false, turretRight:false, fire:false, fireOnce:false });
  }

  // ── Enemy AI ─────────────────────────────────────────────────────────────────
  // Suppress AI fire when player is inside a smoke cloud
  const _playerObscured = _isInSmoke(player.position.x, player.position.z);
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    if (!enemy.alive) continue;
    aiControllers[i].update(dt, player, combat, particles, _playerObscured);
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
        // Destroy the tree — small wood-chip burst at tree base
        chunkManager.destroyTree(tree.key, tree.idx);
        particles.treeBurst(tree.wx, tree.alt, tree.wz);
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
      hudHitIndicator.style.opacity = Math.max(0, _hitIndTimer).toFixed(2);
      if (_hitIndTimer <= 0) hudHitIndicator.style.opacity = '0';
    }
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
  if (player.alive && input.fireOnce) {
    const tip = combat.fire(player, _ammoType);
    if (tip) { particles.muzzleFlash(tip.x, tip.y, tip.z); audio.playFire(); addShake(0.7); }
  }

  // ── Smoke grenade (player) ────────────────────────────────────────────────────
  if (player.alive && input.smokeOnce) _fireSmokeGrenade();

  // ── Artillery support (player) ────────────────────────────────────────────────
  if (player.alive && input.artilleryOnce) _callArtillery();

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
      } else {
        hudHitIndicator.textContent  = `${zone}  ·  DEFLECTED`;
        hudHitIndicator.style.color  = 'rgba(255, 220, 60, 0.95)';
      }
      hudHitIndicator.style.opacity = '1';
      _hitIndTimer = imp.penetrated ? 2.0 : 1.5;
    }
    if (imp.tank && !imp.tank.alive) {
      _processTankDeath(imp.tank, imp.firedBy);
      if (wingmen.includes(imp.tank) && hudHitIndicator) {
        hudHitIndicator.textContent = '✖  FRIENDLY TANK DESTROYED';
        hudHitIndicator.style.color = 'rgba(255, 100, 60, 0.95)';
        hudHitIndicator.style.opacity = '1';
        _hitIndTimer = 3.5;
      }
    }

    // ── Player shot alerts nearby enemies to retarget immediately ─────────────
    // Direct hit: alert the struck tank's controller.
    // Near miss: alert any enemy AI within 3m of impact point.
    if (imp.firedBy === player) {
      for (let ci = 0; ci < aiControllers.length; ci++) {
        const ai = aiControllers[ci];
        if (!ai.tank.alive) continue;
        const isDirectHit = imp.tank === ai.tank;
        if (!isDirectHit) {
          const ex = ai.tank.position.x - imp.x;
          const ez = ai.tank.position.z - imp.z;
          if (ex * ex + ez * ez > 9) continue;   // > 3m, skip
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

  // ── Fleet death tracking (Attrition / Strategy) ───────────────────────────────
  if (_gameMode !== MODES.ARCADE && _playerFleet.length > 0) {
    for (let i = 0; i < _playerFleet.length; i++) {
      if (_prevFleetAlive[i] && !_playerFleet[i].alive) {
        _prevFleetAlive[i] = false;
        _showFleetHUD();
        // Score penalty for losing a friendly tank
        game.score = Math.max(0, game.score - 50);
      }
    }
  }

  // ── Objective (Strategy) ──────────────────────────────────────────────────────
  if (_gameMode === MODES.STRATEGY) _updateObjective(dt);

  // ── End-condition checks ──────────────────────────────────────────────────────
  if (_gameMode === MODES.ATTRITION || _gameMode === MODES.STRATEGY) {
    game.checkFleetEndConditions(_playerFleet, enemies);
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
          clearCraters(); _resetSmoke(); _resetArtillery();
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
      const dmgLabel = pct <= 25 ? ' ¼ SPD' : pct <= 50 ? ' ½ SPD' : '';
      hudHp.textContent   = `HP ${pct}%${dmgLabel}`;
      hudHp.style.color   = pct > 50 ? 'rgba(120,255,120,0.85)'
                          : pct > 25 ? 'rgba(255,200,80,0.9)'
                          :            'rgba(255,80,80,0.95)';
    }
  }

  // ── Minimap ───────────────────────────────────────────────────────────────────
  updateMinimap();

  input.tick();
}

animate(performance.now());
