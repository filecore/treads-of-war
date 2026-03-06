// terrain.js — Fourier landscape engine (Zarch/Lander algorithm)
// Reference: https://lander.bbcelite.com/

import * as THREE from 'three';
import { CONFIG } from './config.js';

// ─── Fourier altitude function ────────────────────────────────────────────────
export function getAltitude(worldX, worldZ) {
  const x = worldX * CONFIG.TERRAIN_FREQ;
  const z = worldZ * CONFIG.TERRAIN_FREQ;

  const sum = (
    2 * Math.sin(x  -  2 * z) +
    2 * Math.sin(4 * x  +  3 * z) +
    2 * Math.sin(3 * z  -  5 * x) +
    2 * Math.sin(3 * x  +  3 * z) +
    1 * Math.sin(5 * x  + 11 * z) +
    1 * Math.sin(10 * x +  7 * z)
  );

  const alt = CONFIG.LAND_BASE + sum * CONFIG.LAND_AMP;
  return Math.max(alt, CONFIG.SEA_LEVEL);
}

// ─── Flat-shading colour lookup ───────────────────────────────────────────────
const _lightDir = new THREE.Vector3(
  CONFIG.LIGHT_DIR.x,
  CONFIG.LIGHT_DIR.y,
  CONFIG.LIGHT_DIR.z,
).normalize();

const _edge1 = new THREE.Vector3();
const _edge2 = new THREE.Vector3();
const _norm  = new THREE.Vector3();

// Deterministic noise from triangle centroid — unique per triangle (not per tile)
function _triNoise(fx, fz) {
  const n = Math.sin(fx * 127.1 + fz * 311.7) * 43758.5453;
  return n - Math.floor(n);  // [0, 1)
}

// Approximate max altitude: LAND_BASE + 10 * LAND_AMP (Fourier sum peaks at ±10)
const _ALT_RANGE = CONFIG.LAND_BASE + 10 * CONFIG.LAND_AMP - CONFIG.SEA_LEVEL;

// Smooth altitude gradient: sea-level (0) → vivid green → dark green → olive → warm brown (1)
// Colour stops derived from the original Conqueror screenshot palette.
function _altGradient(altFrac) {
  let r, g, b;
  if (altFrac < 0.10) {
    // Sand/beach → vivid bright green
    const t = altFrac / 0.10;
    r = 0.800 + (0.267 - 0.800) * t;   // 0xCC → 0x44
    g = 0.600 + (0.733 - 0.600) * t;   // 0x99 → 0xBB
    b = 0.333 + (0.200 - 0.333) * t;   // 0x55 → 0x33
  } else if (altFrac < 0.45) {
    // Vivid green → mid-dark green
    const t = (altFrac - 0.10) / 0.35;
    r = 0.267 + (0.200 - 0.267) * t;   // 0x44 → 0x33
    g = 0.733 + (0.533 - 0.733) * t;   // 0xBB → 0x88
    b = 0.200 + (0.133 - 0.200) * t;   // 0x33 → 0x22
  } else if (altFrac < 0.72) {
    // Mid-dark green → olive/brown-green
    const t = (altFrac - 0.45) / 0.27;
    r = 0.200 + (0.400 - 0.200) * t;   // 0x33 → 0x66
    g = 0.533 + (0.467 - 0.533) * t;   // 0x88 → 0x77
    b = 0.133 + (0.200 - 0.133) * t;   // 0x22 → 0x33
  } else {
    // Olive → warm brown/orange (hilltops)
    const t = Math.min(1, (altFrac - 0.72) / 0.28);
    r = 0.400 + (0.600 - 0.400) * t;   // 0x66 → 0x99
    g = 0.467 + (0.400 - 0.467) * t;   // 0x77 → 0x66
    b = 0.200 + (0.267 - 0.200) * t;   // 0x33 → 0x44
  }
  return [r, g, b];
}

function triColor(p0x, p0y, p0z, p1x, p1y, p1z, p2x, p2y, p2z, outR, outG, outB, oi) {
  const avgAlt = (p0y + p1y + p2y) / 3;
  let r, g, b;

  if (avgAlt <= CONFIG.SEA_LEVEL + 0.5) {
    // Flat water — no shading variation
    const hex = CONFIG.COLOURS.water;
    r = ((hex >> 16) & 0xff) / 255;
    g = ((hex >>  8) & 0xff) / 255;
    b = ((hex      ) & 0xff) / 255;
  } else {
    _edge1.set(p1x - p0x, p1y - p0y, p1z - p0z);
    _edge2.set(p2x - p0x, p2y - p0y, p2z - p0z);
    _norm.crossVectors(_edge1, _edge2).normalize();

    const dot   = _norm.dot(_lightDir);
    const light = Math.max(CONFIG.AMBIENT_MIN, dot);

    // Smooth altitude → colour gradient (each triangle independently)
    const altFrac = Math.max(0, Math.min(1, (avgAlt - CONFIG.SEA_LEVEL) / _ALT_RANGE));
    [r, g, b] = _altGradient(altFrac);

    // Per-triangle noise: triangle centroid differs between the two tris of a tile
    // so each gets a unique, stable shade offset — no grid/checkerboard artefact
    const cx = (p0x + p1x + p2x) / 3;
    const cz = (p0z + p1z + p2z) / 3;
    const noise = 0.94 + _triNoise(cx / CONFIG.TILE_SIZE, cz / CONFIG.TILE_SIZE) * 0.12;

    // Quantise to 12 discrete levels for the retro stepped-colour look
    const LEVELS = 12;
    r = Math.round(r * light * noise * LEVELS) / LEVELS;
    g = Math.round(g * light * noise * LEVELS) / LEVELS;
    b = Math.round(b * light * noise * LEVELS) / LEVELS;
  }

  for (let v = 0; v < 3; v++) {
    outR[oi + v] = r;
    outG[oi + v] = g;
    outB[oi + v] = b;
  }
}

// ─── Chunk mesh builder ───────────────────────────────────────────────────────
function buildChunkMesh(chunkX, chunkZ) {
  const T  = CONFIG.CHUNK_TILES;
  const TS = CONFIG.TILE_SIZE;

  const triCount = T * T * 2;
  const vCount   = triCount * 3;

  const positions = new Float32Array(vCount * 3);
  const colorsR   = new Float32Array(vCount);
  const colorsG   = new Float32Array(vCount);
  const colorsB   = new Float32Array(vCount);
  const colArr    = new Float32Array(vCount * 3);

  let pi = 0;
  let vi = 0;

  for (let tz = 0; tz < T; tz++) {
    for (let tx = 0; tx < T; tx++) {
      const wx0 = (chunkX * T + tx) * TS;
      const wz0 = (chunkZ * T + tz) * TS;
      const wx1 = wx0 + TS;
      const wz1 = wz0 + TS;

      const y00 = getAltitude(wx0, wz0);
      const y10 = getAltitude(wx1, wz0);
      const y01 = getAltitude(wx0, wz1);
      const y11 = getAltitude(wx1, wz1);

      positions[pi++] = wx0; positions[pi++] = y00; positions[pi++] = wz0;
      positions[pi++] = wx0; positions[pi++] = y01; positions[pi++] = wz1;
      positions[pi++] = wx1; positions[pi++] = y10; positions[pi++] = wz0;
      triColor(wx0,y00,wz0, wx0,y01,wz1, wx1,y10,wz0, colorsR, colorsG, colorsB, vi);
      vi += 3;

      positions[pi++] = wx1; positions[pi++] = y10; positions[pi++] = wz0;
      positions[pi++] = wx0; positions[pi++] = y01; positions[pi++] = wz1;
      positions[pi++] = wx1; positions[pi++] = y11; positions[pi++] = wz1;
      triColor(wx1,y10,wz0, wx0,y01,wz1, wx1,y11,wz1, colorsR, colorsG, colorsB, vi);
      vi += 3;
    }
  }

  for (let i = 0; i < vCount; i++) {
    colArr[i * 3    ] = colorsR[i];
    colArr[i * 3 + 1] = colorsG[i];
    colArr[i * 3 + 2] = colorsB[i];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colArr,    3));
  geo.computeBoundingSphere();

  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  return new THREE.Mesh(geo, mat);
}

// ─── Tree type definitions ────────────────────────────────────────────────────
// Each type has shared geometries + materials (never disposed).
// weight controls weighted-random selection.
const _TREE_TYPES = [
  // Type 0: Tall conifer — narrow dark-green cone, thin trunk (most common)
  {
    weight: 5,
    trunkGeo: new THREE.CylinderGeometry(0.10, 0.18, 1.5, 6),
    trunkMat: new THREE.MeshLambertMaterial({ color: 0x664422, flatShading: true }),
    makeParts(scl) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.80, 2.8, 6),
        new THREE.MeshLambertMaterial({ color: 0x116622, flatShading: true }),
      );
      cone.position.y = 1.5 + 1.4;
      return [{ mesh: cone, yo: 0 }];
    },
    trunkH: 1.5,
  },
  // Type 1: Large deciduous — faceted icosahedron canopy, bright vivid green (rare)
  {
    weight: 1,
    trunkGeo: new THREE.CylinderGeometry(0.18, 0.28, 2.2, 6),
    trunkMat: new THREE.MeshLambertMaterial({ color: 0x664422, flatShading: true }),
    makeParts(scl) {
      const blob = new THREE.Mesh(
        new THREE.IcosahedronGeometry(2.5, 1),
        new THREE.MeshLambertMaterial({ color: 0x33CC22, flatShading: true }),
      );
      blob.position.y = 2.2 + 2.5 * 0.8;
      blob.rotation.set(Math.random() * 2, Math.random() * 6.28, Math.random() * 2);
      return [{ mesh: blob, yo: 0 }];
    },
    trunkH: 2.2,
  },
  // Type 2: Medium tiered conifer — two stacked cones
  {
    weight: 3,
    trunkGeo: new THREE.CylinderGeometry(0.12, 0.20, 1.2, 6),
    trunkMat: new THREE.MeshLambertMaterial({ color: 0x664422, flatShading: true }),
    makeParts(scl) {
      const parts = [];
      for (let t = 0; t < 2; t++) {
        const tierScale = 1 - t * 0.32;
        const tierH     = 1.8;
        const tierR     = 1.2 * tierScale;
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(tierR, tierH, 6),
          new THREE.MeshLambertMaterial({ color: 0x228822, flatShading: true }),
        );
        cone.position.y = 1.2 + tierH * 0.5 + t * tierH * 0.58;
        parts.push({ mesh: cone, yo: 0 });
      }
      return parts;
    },
    trunkH: 1.2,
  },
  // Type 3: Small conifer — compact single cone
  {
    weight: 3,
    trunkGeo: new THREE.CylinderGeometry(0.08, 0.14, 0.9, 6),
    trunkMat: new THREE.MeshLambertMaterial({ color: 0x554422, flatShading: true }),
    makeParts(scl) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.60, 1.6, 6),
        new THREE.MeshLambertMaterial({ color: 0x1A7722, flatShading: true }),
      );
      cone.position.y = 0.9 + 0.8;
      return [{ mesh: cone, yo: 0 }];
    },
    trunkH: 0.9,
  },
];

// Build cumulative weight table for weighted random selection
const _TREE_TOTAL_WEIGHT = _TREE_TYPES.reduce((s, t) => s + t.weight, 0);
function _pickTreeType(rngVal) {
  let acc = 0;
  for (const t of _TREE_TYPES) {
    acc += t.weight / _TREE_TOTAL_WEIGHT;
    if (rngVal < acc) return t;
  }
  return _TREE_TYPES[0];
}

// ─── Terrain objects (trees) ──────────────────────────────────────────────────

const TREES_PER_CHUNK = 6;
const TREE_MIN_ALT    = CONFIG.SEA_LEVEL + 4;  // no trees on water or beach

// Cheap deterministic RNG seeded by chunk coordinates
class SeededRng {
  constructor(seed) { this._s = (seed ^ 0xDEADBEEF) >>> 0; }
  next() {
    this._s = (Math.imul(this._s, 1664525) + 1013904223) >>> 0;
    return this._s / 0x100000000;
  }
}

// Build (or rebuild) a THREE.Group from treeData, skipping indices in deadSet.
// treeData: [{wx, wz, alt, s, typeIdx, rotY}, ...]
function _rebuildTreeGroup(treeData, deadSet) {
  const grp = new THREE.Group();

  for (let i = 0; i < treeData.length; i++) {
    if (deadSet && deadSet.has(i)) continue;
    const { wx, wz, alt, s, typeIdx, rotY } = treeData[i];
    const type = _TREE_TYPES[typeIdx];

    // Trunk
    const trunkGeo = type.trunkGeo.clone();
    const trunkMesh = new THREE.Mesh(trunkGeo, type.trunkMat);
    trunkMesh.position.set(wx, alt + type.trunkH * 0.5 * s, wz);
    trunkMesh.scale.setScalar(s);
    grp.add(trunkMesh);

    // Canopy / crown parts — makeParts sets mesh.position.y to local (unscaled) height
    for (const { mesh } of type.makeParts(s)) {
      const localY = mesh.position.y;   // unscaled height set by makeParts
      mesh.position.set(wx, alt + localY * s, wz);
      mesh.scale.setScalar(s);
      mesh.rotation.y = rotY;
      grp.add(mesh);
    }
  }
  return grp;
}

// Returns { group, treeData } where treeData is [{wx,wz,alt,s,typeIdx,rotY}, ...].
// roadFilter: optional (x, z) => bool — skip tree placement when true.
function buildChunkObjects(chunkX, chunkZ, roadFilter = null) {
  const CTS = CONFIG.CHUNK_TILES * CONFIG.TILE_SIZE;
  const wx0 = chunkX * CTS;
  const wz0 = chunkZ * CTS;

  const rng      = new SeededRng((chunkX * 73856093) ^ (chunkZ * 19349663));
  const treeData = [];

  for (let i = 0; i < TREES_PER_CHUNK; i++) {
    const wx  = wx0 + rng.next() * CTS;
    const wz  = wz0 + rng.next() * CTS;
    const alt = getAltitude(wx, wz);
    if (alt < TREE_MIN_ALT) { rng.next(); rng.next(); rng.next(); continue; }

    const s       = 0.80 + rng.next() * 0.40;        // scale ±15% around 1.0
    const typeIdx = _TREE_TYPES.indexOf(_pickTreeType(rng.next()));
    const rotY    = rng.next() * Math.PI * 2;

    if (roadFilter && roadFilter(wx, wz)) continue;
    treeData.push({ wx, wz, alt, s, typeIdx, rotY });
  }

  return { group: _rebuildTreeGroup(treeData, null), treeData };
}

// ─── Chunk Manager ────────────────────────────────────────────────────────────
export class ChunkManager {
  constructor(scene) {
    this.scene     = scene;
    this.chunks    = new Map();   // key → terrain Mesh
    this.objects   = new Map();   // key → objects Group (trees etc.)
    this.treeData  = new Map();   // key → [{wx,wz,alt,s}, ...]
    this.deadTrees = new Map();   // key → Set<index>
    this.roadFilter = null;
    this._cx       = null;
    this._cz       = null;
  }

  setRoadFilter(fn) { this.roadFilter = fn; }

  update(worldX, worldZ) {
    const CTS  = CONFIG.CHUNK_TILES * CONFIG.TILE_SIZE;
    const half = Math.floor(CONFIG.VIEW_CHUNKS / 2);

    const cx = Math.floor(worldX / CTS);
    const cz = Math.floor(worldZ / CTS);

    if (cx === this._cx && cz === this._cz) return;
    this._cx = cx;
    this._cz = cz;

    const needed = new Set();
    for (let dz = -half; dz <= half; dz++) {
      for (let dx = -half; dx <= half; dx++) {
        const ccx = cx + dx;
        const ccz = cz + dz;

        // Skip chunks whose centre lies beyond the play-area boundary.
        const centerX = (ccx + 0.5) * CTS;
        const centerZ = (ccz + 0.5) * CTS;
        if (Math.abs(centerX) > CONFIG.MAP_HALF + CTS * 0.5) continue;
        if (Math.abs(centerZ) > CONFIG.MAP_HALF + CTS * 0.5) continue;

        const key = `${ccx},${ccz}`;
        needed.add(key);
        if (!this.chunks.has(key)) {
          const mesh = buildChunkMesh(ccx, ccz);
          this.scene.add(mesh);
          this.chunks.set(key, mesh);

          const { group, treeData } = buildChunkObjects(ccx, ccz, this.roadFilter);
          this.scene.add(group);
          this.objects.set(key, group);
          this.treeData.set(key, treeData);
        }
      }
    }

    for (const [key, mesh] of this.chunks) {
      if (!needed.has(key)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.chunks.delete(key);

        const objs = this.objects.get(key);
        if (objs) {
          this.scene.remove(objs);
          objs.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
          this.objects.delete(key);
        }
        this.treeData.delete(key);
        this.deadTrees.delete(key);
      }
    }
  }

  // Mark tree at (key, idx) as destroyed, rebuild the chunk's merged mesh without it.
  destroyTree(key, idx) {
    let dead = this.deadTrees.get(key);
    if (!dead) { dead = new Set(); this.deadTrees.set(key, dead); }
    if (dead.has(idx)) return;
    dead.add(idx);

    const oldGrp = this.objects.get(key);
    if (oldGrp) {
      this.scene.remove(oldGrp);
      oldGrp.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    }
    const data   = this.treeData.get(key) || [];
    const newGrp = _rebuildTreeGroup(data, dead);
    this.scene.add(newGrp);
    this.objects.set(key, newGrp);
  }

  // Returns [{key, idx, wx, wz, alt, s}] for all live trees within radiusSq of (x,z).
  getTreesNear(x, z, radiusSq) {
    const result = [];
    for (const [key, data] of this.treeData) {
      const dead = this.deadTrees.get(key);
      for (let i = 0; i < data.length; i++) {
        if (dead && dead.has(i)) continue;
        const { wx, wz, alt, s } = data[i];
        const dx = x - wx, dz = z - wz;
        if (dx * dx + dz * dz < radiusSq) result.push({ key, idx: i, wx, wz, alt, s });
      }
    }
    return result;
  }

  dispose() {
    for (const [, mesh] of this.chunks) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunks.clear();

    for (const [, objs] of this.objects) {
      this.scene.remove(objs);
      objs.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    }
    this.objects.clear();
    this.treeData.clear();
    this.deadTrees.clear();
  }
}
