// models.js — Authentic tank geometry from original Conqueror / Archimedes face data
//
// Coordinate mapping (original → Three.js):
//   orig +X (forward)  → Three.js -Z  (tz = +orig_x, so neg orig_x = neg Three.js Z = forward)
//   orig +Y (screen-down, 0=hull-top, max=tracks) → Three.js +Y inverted: (maxY - origY) * VERT_SCALE
//   orig +Z (right)    → Three.js +X
//
// Scale: VERT_SCALE = 1/160
//
// Turret verts have negative orig-Y (0=hull-deck, -60=turret-top).
// The turretGroup pivot sits at tcy = maxY * VERT_SCALE (hull-deck level).
// Turret mesh verts are stored in turretGroup local space (oy=tcy subtracted).

import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';

const VERT_SCALE = 1 / 160;

// ── Baked lighting — quantised palette shading (Archimedes-style) ─────────────
// The original Archimedes had a 256-colour palette; the engine snapped each face
// to one of ~8 discrete green shades.  That quantisation is what makes every
// polygon visibly distinct — adjacent faces at slightly different angles snap to
// DIFFERENT palette entries rather than blending smoothly together.
//
// Pipeline per face:
//   1. Compute dot(faceNormal, BAKED_LIGHT)  ∈ [-1, +1]
//   2. Map to continuous brightness:  0.55 + dot * 0.40  →  [0.15, 0.95]
//   3. QUANTISE to 8 discrete levels  →  hard edges between panels
//   4. Apply warm (yellow-green) shift on lit faces, cool shift on shadow
//
// The resulting 8-step range, applied to 0x55BB22:
//   step 7 (brightest) ≈ 0x88EE44  — lime highlight
//   step 5             ≈ 0x55BB22  — vivid mid-green
//   step 3             ≈ 0x336611  — deep forest green
//   step 1 (darkest)   ≈ 0x1A3308  — near-black green shadow
const BAKED_LIGHT  = new THREE.Vector3(-0.4, 0.7, -0.5).normalize();
const BAKED_LEVELS = 8;   // palette quantisation steps

// Base colours — vivid/saturated so quantised steps span the full range.
// Allied and Russian are both vivid green but clearly distinct from each other.
const BASE_COLORS = {
  american: 0x77DD22,   // bright lime-yellow green — pops against all terrain shades
  russian:  0x3D9416,   // darker forest green — clearly distinct from Allied lime
  german:   0xD4B822,   // dunkelgelb yellow (unchanged)
  mercenary: 0x4488BB,  // steel blue-grey — clearly distinct from all three faction greens/yellows
};

function makeMat() {
  return new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
}

const GUN_MAT = new THREE.MeshBasicMaterial({ color: 0x2A2A2A, side: THREE.DoubleSide });

// Reused scratch vectors — avoid per-face allocation
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _fn = new THREE.Vector3();

// Tracks are always dark steel grey — same for all factions, not a tint of the hull colour.
const TRACK_COLOR = new THREE.Color(0x1A1A18);

// Compute quantised baked colour.  Normal is expected in _fn (already normalised).
// forcedBrightness: if non-null, use this fixed multiplier on base (bypasses dot/quantise/warmshift).
// jitter: small deterministic offset added before quantisation to break up same-normal regions.
function _bakeRGB(base, out, forcedBrightness = null, jitter = 0) {
  if (forcedBrightness !== null) {
    out[0] = Math.min(1, base.r * forcedBrightness);
    out[1] = Math.min(1, base.g * forcedBrightness);
    out[2] = Math.min(1, base.b * forcedBrightness);
    return;
  }
  const dot = _fn.dot(BAKED_LIGHT);
  // Jitter applied before quantisation so adjacent faces with nearly identical normals
  // snap to DIFFERENT palette steps, creating visible hard edges between panels.
  const brightness = Math.round((0.55 + dot * 0.40 + jitter) * BAKED_LEVELS) / BAKED_LEVELS;
  const warmShift  = Math.max(0, dot) * 0.08;
  out[0] = Math.min(1,          base.r * brightness + warmShift);
  out[1] = Math.min(1,          base.g * brightness + warmShift * 0.5);
  out[2] = Math.max(0, Math.min(1, base.b * brightness - warmShift));
}

// Build a mesh from face data with one pre-baked colour per face (flat-poly look).
// modelCy: Y coordinate of the model centroid in mesh local space — used for the
//          outward-normal check that eliminates stray inverted triangles.
// forcedBrightness: when set, every face uses this fixed brightness (bypasses normal/dot).
function buildBakedMesh(faces, verts, turret_start, forTurret, base, mat, ox, oz, maxY, oy = 0, surfFilter = null, forcedBrightness = null, modelCy = 0) {
  const pos = [];
  const col = [];
  const rgb = [0, 0, 0];
  let faceIndex = 0;

  for (const face of faces) {
    const { v, s } = face;
    const isTurret = v.some(vi => vi >= turret_start);
    if (forTurret !== isTurret) continue;
    if (surfFilter !== null && !surfFilter(s)) continue;

    // Transform vertices to Three.js space
    const fp = v.map(vi => {
      const vt = verts[vi];
      return [tx(vt) - ox, (maxY - vt[1]) * VERT_SCALE - oy, tz(vt) - oz];
    });

    let jitter = 0;
    if (forcedBrightness === null) {
      _e1.set(fp[1][0]-fp[0][0], fp[1][1]-fp[0][1], fp[1][2]-fp[0][2]);
      _e2.set(fp[2][0]-fp[0][0], fp[2][1]-fp[0][1], fp[2][2]-fp[0][2]);
      _fn.crossVectors(_e1, _e2).normalize();

      // Outward-normal check: face centroid relative to model centroid must agree with normal.
      // Faces with inverted winding get their normal flipped — eliminates stray bright triangles.
      const fcx = (fp[0][0] + fp[1][0] + fp[2][0]) / 3;
      const fcy = (fp[0][1] + fp[1][1] + fp[2][1]) / 3 - modelCy;
      const fcz = (fp[0][2] + fp[1][2] + fp[2][2]) / 3;
      if (_fn.x * fcx + _fn.y * fcy + _fn.z * fcz < 0) _fn.negate();

      // Deterministic per-face jitter: -0.03, 0, or +0.03 cycling across faces.
      // Forces adjacent co-planar faces onto different palette steps.
      jitter = (faceIndex % 3 - 1) * 0.03;
    }
    _bakeRGB(base, rgb, forcedBrightness, jitter);
    faceIndex++;

    for (const p of fp) {
      pos.push(p[0], p[1], p[2]);
      col.push(rgb[0], rgb[1], rgb[2]);
    }
  }

  if (pos.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  return new THREE.Mesh(geo, mat);
}

// Bake vertex colours onto a ConvexGeometry (must toNonIndexed for flat per-face shading)
function bakeConvexMesh(convexGeo, base, mat) {
  const nonIdx = convexGeo.index !== null ? convexGeo.toNonIndexed() : convexGeo;
  const pa  = nonIdx.attributes.position;
  const col = new Float32Array(pa.count * 3);
  const rgb = [0, 0, 0];

  for (let i = 0; i < pa.count; i += 3) {
    _e1.set(pa.getX(i+1)-pa.getX(i), pa.getY(i+1)-pa.getY(i), pa.getZ(i+1)-pa.getZ(i));
    _e2.set(pa.getX(i+2)-pa.getX(i), pa.getY(i+2)-pa.getY(i), pa.getZ(i+2)-pa.getZ(i));
    _fn.crossVectors(_e1, _e2).normalize();
    // Outward check in turret local space (centroid at origin)
    const fcx = (pa.getX(i) + pa.getX(i+1) + pa.getX(i+2)) / 3;
    const fcy = (pa.getY(i) + pa.getY(i+1) + pa.getY(i+2)) / 3;
    const fcz = (pa.getZ(i) + pa.getZ(i+1) + pa.getZ(i+2)) / 3;
    if (_fn.x * fcx + _fn.y * fcy + _fn.z * fcz < 0) _fn.negate();
    const jitter = ((i / 3) % 3 - 1) * 0.03;
    _bakeRGB(base, rgb, null, jitter);
    for (let j = 0; j < 3; j++) {
      col[(i+j)*3]   = rgb[0];
      col[(i+j)*3+1] = rgb[1];
      col[(i+j)*3+2] = rgb[2];
    }
  }
  nonIdx.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return new THREE.Mesh(nonIdx, mat);
}

// ── Map game def keys → JSON model names ──────────────────────────────────────
const DEF_TO_MODEL = {
  // American
  m24:        'Chaffee',
  m36:        'M36 90mmGMC',
  sherman:    'Sherman Firefly',
  pershing:   'Pershing',
  // German
  pz3:        'Panzer III',
  panther:    'Panther',
  tiger:      'Tiger I',
  kingtiger:  'King Tiger',
  // Russian
  t34:        'T34/76',
  kv1s:       'KV-1S',
  kv85:       'KV-85',
  js2:        'JS II',
  // Mercenary
  marauder:   'Marauder Mk II',
  interceptor:'Interceptor',
  vulture:    'Vulture Type I',
  obliterator:'Obliterator IV',
};

const MODEL_DATA = {
  'Panzer III':{
    v:[[0,0,0],[-180,0,110],[300,0,110],[300,0,-110],[-180,0,-110],[-220,40,-110],[-220,40,110],[-240,60,110],[-240,60,-110],[-260,60,-110],[-260,60,-150],[-260,60,110],[-260,60,150],[300,40,150],[300,40,-150],[300,40,-110],[300,40,110],[-220,40,150],[-220,40,-150],[-220,120,110],[-220,120,-110],[-180,160,110],[-180,160,-110],[-180,160,150],[-180,160,-150],[-260,100,150],[-260,100,-150],[-260,100,110],[-260,100,-110],[300,100,150],[300,100,-150],[220,160,-150],[220,160,150],[220,160,-110],[220,160,110],[300,100,-110],[300,100,110],[300,60,-110],[300,60,110],[260,120,-110],[260,120,110],[-180,40,-110],[-180,40,110],[-120,-60,80],[0,-60,100],[100,-60,60],[140,-60,60],[140,-60,-60],[100,-60,-60],[0,-60,-100],[-120,-60,-80],[-120,0,80],[-120,0,-80],[0,0,-100],[0,0,100],[140,0,-60],[140,0,60],[100,0,-60],[100,0,60]],
    f:[{v:[6,7,8],s:"hull_top"},{v:[5,6,8],s:"hull_top"},{v:[6,11,12],s:"hull_top"},{v:[6,12,17],s:"hull_top"},{v:[5,9,10],s:"hull_top"},{v:[5,10,18],s:"hull_top"},{v:[7,19,20],s:"hull_top"},{v:[7,8,20],s:"hull_top"},{v:[37,38,39],s:"turret_hull_top"},{v:[38,39,40],s:"turret_hull_top"},{v:[14,15,30],s:"hull_sides"},{v:[15,30,35],s:"turret_hull_sides"},{v:[30,31,35],s:"turret_hull_sides"},{v:[31,33,35],s:"turret_hull_sides"},{v:[13,16,29],s:"hull_sides"},{v:[16,29,36],s:"turret_hull_sides"},{v:[29,32,36],s:"turret_hull_sides"},{v:[32,34,36],s:"turret_hull_sides"},{v:[11,12,25],s:"hull_sides"},{v:[11,25,27],s:"hull_sides"},{v:[23,25,27],s:"hull_sides"},{v:[21,23,27],s:"hull_sides"},{v:[22,24,28],s:"hull_sides"},{v:[24,26,28],s:"hull_sides"},{v:[9,26,28],s:"hull_sides"},{v:[9,10,26],s:"hull_sides"},{v:[10,18,26],s:"track_sides"},{v:[18,24,26],s:"track_sides"},{v:[18,24,31],s:"track_sides"},{v:[18,30,31],s:"track_sides"},{v:[14,18,30],s:"track_sides"},{v:[12,17,25],s:"track_sides"},{v:[17,23,25],s:"track_sides"},{v:[17,23,32],s:"track_sides"},{v:[17,29,32],s:"track_sides"},{v:[13,17,29],s:"track_sides"},{v:[42,5,6],s:"turret_hull_top"},{v:[42,41,5],s:"turret_hull_top"},{v:[5,18,41],s:"turret_hull_top"},{v:[15,18,41],s:"turret_hull_top"},{v:[14,15,18],s:"hull_top"},{v:[6,17,42],s:"turret_hull_top"},{v:[16,17,42],s:"turret_hull_top"},{v:[13,16,17],s:"hull_top"},{v:[1,41,42],s:"turret_hull_top"},{v:[1,4,41],s:"turret_hull_top"},{v:[2,3,37],s:"turret_hull_top"},{v:[2,37,38],s:"turret_hull_top"},{v:[4,15,41],s:"turret_hull_top"},{v:[3,4,15],s:"hull_top"},{v:[1,2,16],s:"hull_top"},{v:[1,16,42],s:"turret_hull_top"},{v:[1,2,4],s:"hull_top"},{v:[2,3,4],s:"hull_top"},{v:[47,48,56],s:"turret_hull_top"},{v:[47,56,57],s:"turret_hull_top"},{v:[44,51,52],s:"turret_hull_top"},{v:[51,52,53],s:"turret_hull_top"},{v:[49,56,58],s:"turret_hull_top"},{v:[48,49,56],s:"turret_hull_top"}],
    t:43
  },
  'Panther':{
    v:[[0,0,0],[-260,0,140],[320,0,140],[320,0,-140],[-260,0,-140],[-340,60,-180],[260,120,-180],[260,120,180],[-340,60,180],[-400,80,180],[-400,80,-180],[-400,80,-120],[-400,80,120],[-380,100,120],[-380,100,-120],[-340,60,-120],[-340,60,120],[-400,140,180],[-400,140,-180],[-340,140,120],[-340,140,-120],[-260,200,180],[-260,200,-180],[-260,200,120],[-260,200,-120],[260,160,-180],[260,160,180],[180,200,-180],[180,200,180],[180,200,-120],[180,200,120],[260,160,-120],[260,160,120],[240,140,-120],[240,140,120],[260,120,-120],[260,120,120],[-400,140,-180],[-240,200,-180],[180,200,-180],[260,160,-180],[260,160,180],[180,200,180],[-240,200,180],[-400,140,180],[-400,140,120],[-400,140,-120],[-120,-100,70],[60,-100,90],[100,-100,70],[100,-100,-70],[60,-100,-90],[-120,-100,-70],[-120,0,-110],[60,0,-130],[140,0,-90],[140,0,90],[60,0,130],[-120,0,110],[-160,-60,70],[-160,-60,-70],[-120,-20,70],[-120,-20,-70]],
    f:[{v:[13,14,19],s:"hull_top"},{v:[14,19,20],s:"hull_top"},{v:[9,12,17],s:"hull_sides"},{v:[12,17,45],s:"turret_hull_sides"},{v:[11,18,46],s:"turret_hull_sides"},{v:[10,11,18],s:"hull_sides"},{v:[22,24,46],s:"turret_hull_sides"},{v:[18,22,46],s:"turret_hull_sides"},{v:[17,21,45],s:"turret_hull_sides"},{v:[21,23,45],s:"turret_hull_sides"},{v:[33,35,36],s:"turret_hull_top"},{v:[33,34,36],s:"turret_hull_top"},{v:[6,25,31],s:"turret_hull_sides"},{v:[6,31,35],s:"turret_hull_sides"},{v:[25,27,29],s:"turret_hull_sides"},{v:[25,29,31],s:"turret_hull_sides"},{v:[7,32,36],s:"turret_hull_sides"},{v:[7,32,26],s:"turret_hull_sides"},{v:[26,30,32],s:"turret_hull_sides"},{v:[26,28,30],s:"turret_hull_sides"},{v:[5,10,37],s:"turret_track_sides"},{v:[5,37,38],s:"turret_track_sides"},{v:[5,6,38],s:"turret_track_sides"},{v:[6,38,39],s:"turret_track_sides"},{v:[6,39,40],s:"turret_track_sides"},{v:[8,9,44],s:"turret_track_sides"},{v:[8,43,44],s:"turret_track_sides"},{v:[7,8,43],s:"turret_track_sides"},{v:[7,42,43],s:"turret_track_sides"},{v:[7,41,42],s:"turret_track_sides"},{v:[13,15,16],s:"hull_top"},{v:[13,14,15],s:"hull_top"},{v:[9,12,16],s:"hull_sides"},{v:[8,9,16],s:"hull_sides"},{v:[10,11,15],s:"hull_sides"},{v:[5,10,15],s:"hull_sides"},{v:[2,3,35],s:"turret_hull_top"},{v:[2,35,36],s:"turret_hull_top"},{v:[3,6,35],s:"turret_hull_top"},{v:[2,7,36],s:"turret_hull_top"},{v:[4,5,6],s:"hull_top"},{v:[3,4,6],s:"hull_top"},{v:[1,2,7],s:"hull_top"},{v:[1,7,8],s:"hull_top"},{v:[1,4,16],s:"hull_top"},{v:[4,15,16],s:"hull_top"},{v:[1,8,16],s:"hull_top"},{v:[4,5,15],s:"hull_top"},{v:[1,2,4],s:"hull_top"},{v:[2,3,4],s:"hull_top"},{v:[48,53,59],s:"turret_hull_top"},{v:[53,54,59],s:"turret_hull_top"}],
    t:47
  },
  'Tiger I':{
    v:[[0,0,0],[-240,0,180],[340,0,180],[340,0,-180],[-240,0,-180],[-240,40,180],[340,40,180],[340,40,-180],[-240,40,-180],[-320,60,200],[340,40,200],[340,40,-200],[-320,60,-200],[-240,40,200],[-240,40,-200],[-320,60,120],[-320,60,-120],[-300,140,200],[-300,140,-200],[-300,140,120],[-300,140,-120],[-220,200,200],[-220,200,-200],[-220,200,120],[-220,200,-120],[320,140,-200],[320,140,200],[260,200,-200],[260,200,200],[260,200,-120],[260,200,120],[340,60,-120],[340,60,120],[320,140,-120],[320,140,120],[-140,-80,90],[0,-80,130],[120,-80,50],[120,-80,-50],[0,-80,-130],[-140,-80,-90],[-140,0,90],[0,0,130],[120,0,50],[120,0,-50],[0,0,-130],[-140,0,-90]],
    f:[{v:[17,21,23],s:"hull_sides"},{v:[17,19,23],s:"hull_sides"},{v:[18,20,24],s:"hull_sides"},{v:[18,22,24],s:"hull_sides"},{v:[25,27,33],s:"turret_hull_sides"},{v:[27,29,33],s:"turret_hull_sides"},{v:[28,30,34],s:"turret_hull_sides"},{v:[26,28,34],s:"turret_hull_sides"},{v:[11,25,31],s:"turret_hull_sides"},{v:[25,31,33],s:"turret_hull_sides"},{v:[26,32,34],s:"turret_hull_sides"},{v:[10,26,32],s:"turret_hull_sides"},{v:[9,17,19],s:"hull_sides"},{v:[9,15,19],s:"hull_sides"},{v:[12,16,20],s:"hull_sides"},{v:[12,18,20],s:"hull_sides"},{v:[12,14,18],s:"track_sides"},{v:[14,18,22],s:"track_sides"},{v:[14,22,27],s:"track_sides"},{v:[11,14,27],s:"track_sides"},{v:[11,25,27],s:"track_sides"},{v:[9,13,17],s:"track_sides"},{v:[13,17,21],s:"track_sides"},{v:[13,21,28],s:"track_sides"},{v:[10,13,28],s:"track_sides"},{v:[10,26,28],s:"track_sides"},{v:[31,32,33],s:"turret_hull_top"},{v:[32,33,34],s:"turret_hull_top"},{v:[15,19,20],s:"hull_top"},{v:[15,16,20],s:"hull_top"},{v:[5,9,12],s:"hull_top"},{v:[5,8,12],s:"hull_top"},{v:[5,9,13],s:"hull_top"},{v:[8,12,14],s:"hull_top"},{v:[5,6,13],s:"hull_top"},{v:[6,10,13],s:"hull_top"},{v:[7,8,14],s:"hull_top"},{v:[7,11,14],s:"hull_top"},{v:[2,3,31],s:"turret_hull_top"},{v:[2,31,32],s:"turret_hull_top"},{v:[3,7,31],s:"turret_hull_top"},{v:[2,6,32],s:"turret_hull_top"},{v:[1,4,5],s:"hull_top"},{v:[4,5,8],s:"hull_top"},{v:[3,4,8],s:"hull_top"},{v:[3,7,8],s:"hull_top"},{v:[1,2,5],s:"hull_top"},{v:[2,5,6],s:"hull_top"},{v:[1,2,4],s:"hull_top"},{v:[2,3,4],s:"hull_top"}],
    t:35
  },
  'King Tiger':{
    v:[[0,0,0],[-280,0,140],[380,0,140],[380,0,-140],[-280,0,-140],[-400,100,-200],[-400,100,200],[300,120,200],[300,120,-200],[-400,100,-120],[-400,100,120],[-340,160,-120],[-340,160,120],[300,120,-120],[300,120,120],[280,160,-120],[280,160,120],[-400,160,-200],[-400,160,200],[-300,220,-200],[-300,220,200],[-300,220,-120],[-300,220,120],[-400,160,-120],[-400,160,120],[300,160,-200],[300,160,200],[300,160,-120],[300,160,120],[240,220,-200],[240,220,200],[240,220,-120],[240,220,120],[-200,-80,60],[0,-120,100],[180,-80,60],[180,-80,-60],[0,-120,-100],[-200,-80,-60],[-200,0,80],[0,0,140],[200,0,80],[200,0,-80],[0,0,-140],[-200,0,-80]],
    f:[{v:[10,11,12],s:"hull_top"},{v:[9,10,11],s:"hull_top"},{v:[13,14,15],s:"hull_top"},{v:[14,15,16],s:"hull_top"},{v:[8,13,25],s:"hull_sides"},{v:[13,25,27],s:"hull_sides"},{v:[25,27,29],s:"hull_sides"},{v:[27,29,31],s:"turret_hull_sides"},{v:[26,28,30],s:"hull_sides"},{v:[28,30,32],s:"turret_hull_sides"},{v:[14,26,28],s:"hull_sides"},{v:[7,14,26],s:"hull_sides"},{v:[6,10,18],s:"hull_sides"},{v:[10,18,24],s:"hull_sides"},{v:[18,20,24],s:"hull_sides"},{v:[20,22,24],s:"hull_sides"},{v:[5,9,17],s:"hull_sides"},{v:[9,17,23],s:"hull_sides"},{v:[17,19,23],s:"hull_sides"},{v:[19,21,23],s:"hull_sides"},{v:[5,17,19],s:"track_sides"},{v:[5,19,29],s:"track_sides"},{v:[5,8,29],s:"track_sides"},{v:[8,25,29],s:"track_sides"},{v:[6,18,20],s:"track_sides"},{v:[6,20,30],s:"track_sides"},{v:[6,7,30],s:"track_sides"},{v:[7,26,30],s:"track_sides"},{v:[2,3,13],s:"hull_top"},{v:[2,13,14],s:"hull_top"},{v:[3,8,13],s:"hull_top"},{v:[2,7,14],s:"hull_top"},{v:[1,9,10],s:"hull_top"},{v:[1,4,9],s:"hull_top"},{v:[1,6,10],s:"hull_top"},{v:[4,5,9],s:"hull_top"},{v:[1,2,6],s:"hull_top"},{v:[2,6,7],s:"hull_top"},{v:[3,4,5],s:"hull_top"},{v:[3,5,8],s:"hull_top"},{v:[1,2,4],s:"hull_top"},{v:[2,3,4],s:"hull_top"},{v:[36,37,43],s:"turret_hull_top"},{v:[36,42,43],s:"turret_hull_top"},{v:[34,39,40],s:"turret_hull_top"}],
    t:33
  },
  'Chaffee':{
    v:[[0,0,0],[-120,0,110],[180,0,110],[180,0,-110],[-120,0,-110],[-220,60,-110],[-220,60,110],[300,60,110],[300,60,-110],[300,60,-150],[-220,60,-150],[-220,60,150],[300,60,150],[300,100,150],[300,100,-150],[200,160,150],[200,160,-150],[200,160,110],[200,160,-110],[300,100,-110],[300,100,110],[260,100,-110],[260,100,110],[-220,100,150],[-220,100,-150],[-120,160,150],[-120,160,-150],[-120,160,110],[-120,160,-110],[-220,100,110],[-220,100,-110],[-180,100,110],[-180,100,-110],[-80,-60,50],[0,-60,110],[180,-40,50],[180,-40,-50],[0,-60,-110],[-80,-60,-50],[-100,-30,-50],[-100,-30,50],[0,0,-110],[0,0,110],[-80,0,50],[-80,0,-50],[180,0,-50],[180,0,50]],
    f:[{v:[5,6,31],s:"turret_hull_top"},{v:[5,31,32],s:"turret_hull_top"},{v:[7,8,21],s:"turret_hull_top"},{v:[7,21,22],s:"turret_hull_top"},{v:[6,11,23],s:"turret_hull_sides"},{v:[6,23,29],s:"turret_hull_sides"},{v:[23,25,29],s:"turret_hull_sides"},{v:[25,27,29],s:"turret_hull_sides"},{v:[5,10,24],s:"turret_hull_sides"},{v:[5,24,30],s:"turret_hull_sides"},{v:[24,26,30],s:"turret_hull_sides"},{v:[26,28,30],s:"turret_hull_sides"},{v:[8,9,14],s:"hull_sides"},{v:[8,14,19],s:"turret_hull_sides"},{v:[14,16,19],s:"turret_hull_sides"},{v:[16,18,19],s:"turret_hull_sides"},{v:[7,12,13],s:"hull_sides"},{v:[7,13,20],s:"turret_hull_sides"},{v:[13,15,20],s:"turret_hull_sides"},{v:[15,17,20],s:"turret_hull_sides"},{v:[12,13,15],s:"track_sides"},{v:[12,15,25],s:"turret_track_sides"},{v:[12,23,25],s:"turret_track_sides"},{v:[11,12,23],s:"turret_track_sides"},{v:[9,10,24],s:"turret_track_sides"},{v:[9,24,26],s:"turret_track_sides"},{v:[9,16,26],s:"turret_track_sides"},{v:[9,14,16],s:"track_sides"},{v:[6,7,11],s:"hull_top"},{v:[7,11,12],s:"hull_top"},{v:[5,8,10],s:"hull_top"},{v:[8,9,10],s:"hull_top"},{v:[3,4,5],s:"hull_top"},{v:[3,8,5],s:"hull_top"},{v:[1,2,6],s:"hull_top"},{v:[2,6,7],s:"hull_top"},{v:[1,2,4],s:"hull_top"},{v:[2,3,4],s:"hull_top"},{v:[1,5,6],s:"hull_top"},{v:[1,4,5],s:"hull_top"},{v:[2,3,7],s:"hull_top"},{v:[3,7,8],s:"hull_top"},{v:[40,41,44],s:"turret_hull_sides"},{v:[40,44,45],s:"turret_hull_sides"},{v:[34,35,43],s:"turret_hull_sides"},{v:[34,44,43],s:"turret_hull_sides"},{v:[38,39,42],s:"turret_hull_sides"},{v:[39,45,42],s:"turret_hull_sides"}],
    t:33
  },
  'M36 90mmGMC':{
    v:[[0,0,0],[-160,0,120],[280,0,120],[280,0,-120],[-160,0,-120],[-240,60,-160],[-240,60,160],[300,60,160],[300,60,-160],[-240,60,-100],[-240,60,100],[-300,100,100],[-300,100,-100],[-320,60,160],[-320,60,100],[-320,60,-100],[-320,60,-160],[-300,120,160],[-180,160,160],[160,160,160],[280,120,160],[280,60,160],[-300,120,-160],[-180,160,-160],[160,160,-160],[280,120,-160],[280,60,-160],[-300,120,100],[-300,120,-100],[-180,160,100],[-180,160,-100],[160,160,100],[160,160,-100],[280,120,100],[280,120,-100],[300,60,100],[300,60,-100],[-80,-60,50],[0,-60,110],[180,-40,50],[180,-40,-50],[0,-60,-110],[-80,-60,-50],[-100,-30,-50],[-100,-30,50],[0,0,-110],[0,0,110],[-80,0,50],[-80,0,-50],[180,0,-50],[180,0,50]],
    f:[{v:[17,18,29],s:"hull_sides"},{v:[17,27,29],s:"hull_sides"},{v:[23,28,30],s:"hull_sides"},{v:[22,23,28],s:"hull_sides"},{v:[19,20,33],s:"turret_hull_sides"},{v:[19,31,33],s:"turret_hull_sides"},{v:[25,32,34],s:"turret_hull_sides"},{v:[24,25,32],s:"hull_sides"},{v:[18,19,20],s:"track_sides"},{v:[17,18,20],s:"track_sides"},{v:[23,24,25],s:"track_sides"},{v:[22,23,25],s:"track_sides"},{v:[13,17,27],s:"hull_sides"},{v:[13,14,27],s:"hull_sides"},{v:[15,22,28],s:"hull_sides"},{v:[15,16,22],s:"hull_sides"},{v:[33,35,36],s:"turret_hull_top"},{v:[33,34,36],s:"turret_hull_top"},{v:[20,21,35],s:"turret_hull_sides"},{v:[20,33,35],s:"turret_hull_sides"},{v:[26,34,36],s:"turret_hull_sides"},{v:[25,26,34],s:"turret_hull_sides"},{v:[13,17,20],s:"track_sides"},{v:[13,20,21],s:"track_sides"},{v:[16,22,25],s:"track_sides"},{v:[16,25,26],s:"track_sides"},{v:[5,15,16],s:"hull_top"},{v:[5,9,15],s:"hull_top"},{v:[10,13,14],s:"hull_top"},{v:[6,10,13],s:"hull_top"},{v:[1,3,4],s:"hull_top"},{v:[1,2,3],s:"hull_top"},{v:[1,5,6],s:"hull_top"},{v:[1,4,5],s:"hull_top"},{v:[9,10,11],s:"hull_top"},{v:[9,11,12],s:"hull_top"},{v:[1,6,7],s:"hull_top"},{v:[1,2,7],s:"hull_top"},{v:[4,5,8],s:"hull_top"},{v:[3,4,8],s:"hull_top"},{v:[2,3,7],s:"hull_top"},{v:[3,8,7],s:"hull_top"},{v:[44,45,48],s:"turret_hull_sides"},{v:[44,48,49],s:"turret_hull_sides"},{v:[38,39,47],s:"turret_hull_sides"},{v:[38,48,47],s:"turret_hull_sides"},{v:[42,43,46],s:"turret_hull_sides"},{v:[43,49,46],s:"turret_hull_sides"}],
    t:37
  },
  'Sherman Firefly':{
    v:[[0,0,0],[-140,0,140],[80,0,140],[80,0,-140],[-140,0,-140],[-240,100,-140],[-240,100,140],[300,40,140],[300,40,-140],[340,120,-140],[340,120,140],[-320,100,140],[-320,100,-140],[-320,100,-80],[-320,100,80],[-240,100,-80],[-240,100,80],[-260,120,80],[-260,120,-80],[-240,140,80],[-240,140,-80],[-320,140,140],[-320,140,-140],[-240,200,140],[-240,200,-140],[-240,200,-80],[-240,200,80],[-320,140,80],[-320,140,-80],[340,140,-140],[340,140,140],[340,140,-80],[340,140,80],[240,200,-140],[240,200,140],[240,200,-80],[240,200,80],[300,120,-80],[300,120,80],[300,140,-80],[300,140,80],[340,100,-80],[340,100,80],[-40,-100,110],[60,-100,110],[80,-100,90],[80,-100,-90],[60,-100,-110],[-40,-100,-110],[-80,-100,-50],[-80,-100,50],[-120,-60,50],[-120,-60,-50],[120,-60,50],[120,-60,-50],[160,-60,50],[160,-60,-50],[160,0,-50],[160,0,50],[60,0,110],[60,0,-110],[120,0,50],[120,0,-50],[-40,0,110],[-40,0,-110],[-120,0,50],[-120,0,-50]],
    f:[{v:[17,18,20],s:"hull_top"},{v:[17,19,20],s:"hull_top"},{v:[16,17,18],s:"hull_top"},{v:[15,16,18],s:"hull_top"},{v:[37,38,40],s:"turret_hull_top"},{v:[37,39,40],s:"turret_hull_top"},{v:[12,13,28],s:"hull_sides"},{v:[12,22,28],s:"hull_sides"},{v:[11,14,27],s:"hull_sides"},{v:[11,21,27],s:"hull_sides"},{v:[21,23,26],s:"hull_sides"},{v:[21,26,27],s:"hull_sides"},{v:[22,24,25],s:"hull_sides"},{v:[22,25,28],s:"hull_sides"},{v:[9,29,31],s:"hull_sides"},{v:[9,31,41],s:"turret_hull_sides"},{v:[10,32,42],s:"turret_hull_sides"},{v:[10,30,32],s:"hull_sides"},{v:[30,32,36],s:"turret_hull_sides"},{v:[30,34,36],s:"turret_hull_sides"},{v:[29,33,35],s:"turret_hull_sides"},{v:[29,31,35],s:"turret_hull_sides"},{v:[9,22,24],s:"track_sides"},{v:[9,24,29],s:"track_sides"},{v:[24,29,33],s:"track_sides"},{v:[10,21,23],s:"track_sides"},{v:[10,23,30],s:"track_sides"},{v:[23,30,34],s:"track_sides"},{v:[6,11,14],s:"hull_top"},{v:[6,14,16],s:"hull_top"},{v:[5,13,15],s:"hull_top"},{v:[5,12,13],s:"hull_top"},{v:[7,8,10],s:"hull_top"},{v:[8,9,10],s:"hull_top"},{v:[1,2,7],s:"hull_top"},{v:[1,7,10],s:"hull_top"},{v:[1,6,10],s:"hull_top"},{v:[6,10,21],s:"hull_top"},{v:[6,11,21],s:"hull_top"},{v:[3,4,8],s:"hull_top"},{v:[4,8,9],s:"hull_top"},{v:[4,5,9],s:"hull_top"},{v:[5,9,22],s:"hull_top"},{v:[5,12,22],s:"hull_top"},{v:[2,3,7],s:"hull_top"},{v:[3,7,8],s:"hull_top"},{v:[1,15,16],s:"hull_top"},{v:[1,4,15],s:"hull_top"},{v:[1,6,16],s:"hull_top"},{v:[4,5,15],s:"hull_top"},{v:[1,2,4],s:"hull_top"},{v:[2,3,4],s:"hull_top"},{v:[56,57,58],s:"turret_hull_sides"},{v:[56,58,59],s:"turret_hull_sides"},{v:[52,53,66],s:"turret_hull_sides"}],
    t:43
  },
  'Pershing':{
    v:[[0,0,0],[-140,0,110],[260,0,110],[260,0,-110],[-140,0,-110],[380,20,110],[380,20,-110],[-220,80,-110],[-220,80,110],[-260,40,110],[-260,40,-110],[-260,40,170],[-260,40,-170],[380,40,170],[380,40,-170],[380,40,-110],[380,40,110],[380,100,-110],[380,100,110],[-180,100,110],[-180,100,-110],[-180,140,110],[-180,140,-110],[-180,140,170],[-180,140,-170],[-260,80,170],[-260,80,-170],[320,140,-110],[320,140,110],[320,140,-170],[320,140,170],[380,100,-170],[380,100,170],[-180,40,-110],[-180,40,110],[-260,80,110],[-260,80,-110],[-100,-100,80],[0,-100,120],[200,-100,60],[200,-100,-60],[0,-100,-120],[-100,-100,-80],[-120,0,-80],[-120,0,80],[0,0,-120],[0,0,120],[200,0,-60],[200,0,60]],
    f:[{v:[7,8,19],s:"hull_top"},{v:[7,19,20],s:"hull_top"},{v:[35,11,25],s:"turret_hull_sides"},{v:[35,9,11],s:"turret_hull_sides"},{v:[21,23,25],s:"hull_sides"},{v:[35,21,25],s:"turret_hull_sides"},{v:[36,22,26],s:"turret_hull_sides"},{v:[22,24,26],s:"hull_sides"},{v:[36,10,12],s:"turret_hull_sides"},{v:[36,12,26],s:"turret_hull_sides"},{v:[14,15,31],s:"turret_hull_sides"},{v:[15,17,31],s:"turret_hull_sides"},{v:[17,29,31],s:"turret_hull_sides"},{v:[17,27,29],s:"turret_hull_sides"},{v:[18,28,32],s:"turret_hull_sides"},{v:[28,30,32],s:"turret_hull_sides"},{v:[13,16,18],s:"hull_sides"},{v:[13,18,32],s:"turret_hull_sides"},{v:[12,24,26],s:"track_sides"},{v:[12,24,29],s:"turret_track_sides"},{v:[12,29,31],s:"turret_track_sides"},{v:[12,14,31],s:"turret_track_sides"},{v:[11,23,25],s:"track_sides"},{v:[11,23,30],s:"turret_track_sides"},{v:[11,30,32],s:"turret_track_sides"},{v:[11,13,32],s:"turret_track_sides"},{v:[4,6,15],s:"hull_top"},{v:[1,5,16],s:"hull_top"},{v:[9,11,13],s:"hull_top"},{v:[9,13,16],s:"hull_top"},{v:[10,12,14],s:"hull_top"},{v:[10,14,15],s:"hull_top"},{v:[5,6,17],s:"hull_top"},{v:[5,17,18],s:"hull_top"},{v:[1,2,5],s:"hull_top"},{v:[1,16,34],s:"turret_hull_top"},{v:[3,4,6],s:"hull_top"},{v:[4,15,33],s:"turret_hull_top"},{v:[1,7,8],s:"hull_top"},{v:[1,4,7],s:"hull_top"},{v:[2,3,5],s:"hull_top"},{v:[3,5,6],s:"hull_top"},{v:[1,2,4],s:"hull_top"},{v:[2,3,4],s:"hull_top"},{v:[38,44,45],s:"turret_hull_sides"},{v:[38,43,44],s:"turret_hull_sides"},{v:[40,41,48],s:"turret_hull_sides"}],
    t:37
  },
  'T34/76':{
    v:[[0,0,0],[-240,50,160],[320,50,160],[320,50,-160],[-240,50,-160],[-240,50,100],[360,80,160],[360,80,-160],[-240,50,-100],[-170,50,100],[-170,50,-100],[-100,0,100],[-100,0,-100],[260,0,100],[260,0,-100],[-240,100,100],[-240,100,-100],[320,50,130],[320,50,-130],[-260,120,160],[-260,120,-160],[-170,50,130],[-170,50,-130],[-120,160,160],[-120,160,-160],[260,160,160],[260,160,-160],[360,120,160],[360,120,-160],[320,120,100],[320,120,-100],[360,120,100],[360,120,-100],[260,160,100],[260,160,-100],[360,80,100],[360,80,-100],[-200,120,100],[-200,120,-100],[-260,120,100],[-260,120,-100],[-120,160,100],[-120,160,-100],[-260,70,160],[-260,70,100],[-260,70,-100],[-260,70,-160],[-90,-60,-40],[-90,-60,40],[0,-60,60],[100,-60,20],[100,-60,-20],[0,-60,-60],[-100,0,-60],[-100,0,60],[0,0,90],[120,0,50],[120,0,-50],[0,0,-90]],
    f:[{v:[20,40,42],s:"turret_hull_sides"},{v:[20,24,42],s:"turret_hull_sides"},{v:[19,23,39],s:"turret_hull_sides"},{v:[23,39,41],s:"turret_hull_sides"},{v:[25,27,33],s:"turret_hull_sides"},{v:[27,31,33],s:"turret_hull_sides"},{v:[26,32,34],s:"turret_hull_sides"},{v:[26,28,32],s:"hull_sides"},{v:[19,23,25],s:"track_sides"},{v:[20,24,26],s:"track_sides"},{v:[19,25,27],s:"track_sides"},{v:[20,26,28],s:"track_sides"},{v:[15,16,37],s:"turret_hull_top"},{v:[16,37,38],s:"turret_hull_top"},{v:[10,15,16],s:"hull_top"},{v:[9,10,15],s:"hull_top"},{v:[19,43,44],s:"turret_hull_sides"},{v:[19,39,44],s:"turret_hull_sides"},{v:[40,45,46],s:"turret_hull_sides"},{v:[20,40,46],s:"turret_hull_sides"},{v:[29,30,35],s:"turret_hull_top"},{v:[30,35,36],s:"turret_hull_top"},{v:[6,27,31],s:"hull_sides"},{v:[6,31,35],s:"turret_hull_sides"},{v:[28,32,36],s:"turret_hull_sides"},{v:[7,28,36],s:"turret_hull_sides"},{v:[6,19,27],s:"track_sides"},{v:[7,20,28],s:"track_sides"},{v:[1,6,19],s:"track_sides"},{v:[4,7,20],s:"track_sides"},{v:[1,2,6],s:"track_sides"},{v:[3,4,7],s:"track_sides"},{v:[1,19,43],s:"turret_track_sides"},{v:[4,20,46],s:"turret_track_sides"},{v:[4,18,22],s:"hull_top"},{v:[3,4,18],s:"hull_top"},{v:[1,2,21],s:"hull_top"},{v:[2,17,21],s:"hull_top"},{v:[1,5,21],s:"hull_top"},{v:[5,9,21],s:"hull_top"},{v:[4,8,10],s:"hull_top"},{v:[4,10,22],s:"hull_top"},{v:[1,5,43],s:"turret_hull_top"},{v:[5,43,44],s:"turret_hull_top"},{v:[4,8,45],s:"turret_hull_top"},{v:[4,45,46],s:"turret_hull_top"},{v:[2,6,17],s:"hull_top"},{v:[3,7,18],s:"hull_top"},{v:[6,17,18],s:"hull_top"},{v:[6,7,18],s:"hull_top"},{v:[9,10,12],s:"hull_top"},{v:[9,11,12],s:"hull_top"},{v:[9,11,21],s:"hull_top"},{v:[10,12,22],s:"hull_top"},{v:[13,14,17],s:"hull_top"},{v:[14,17,18],s:"hull_top"},{v:[21,11,17],s:"hull_top"},{v:[11,13,17],s:"hull_top"},{v:[12,18,22],s:"hull_top"},{v:[12,14,18],s:"hull_top"},{v:[11,12,14],s:"hull_top"},{v:[11,13,14],s:"hull_top"},{v:[50,56,57],s:"turret_hull_sides"},{v:[50,51,57],s:"turret_hull_sides"}],
    t:47
  },
  'KV-1S':{
    v:[[0,0,0],[-300,40,170],[400,40,170],[400,40,-170],[-300,40,-170],[-300,40,100],[400,40,100],[400,40,-100],[-300,40,-100],[-200,40,100],[-200,40,-100],[-170,0,100],[-170,0,-100],[380,0,100],[380,0,-100],[-300,60,100],[-300,60,-100],[-280,140,170],[-280,140,-170],[-180,180,170],[-180,180,-170],[260,180,170],[260,180,-170],[380,140,170],[380,140,-170],[-260,140,100],[-260,140,-100],[-280,140,100],[-280,140,-100],[-180,180,100],[-180,180,-100],[380,140,100],[380,140,-100],[260,180,100],[260,180,-100],[340,140,100],[340,140,-100],[-100,-80,-70],[-100,-80,70],[0,-80,80],[140,-80,70],[140,-80,-70],[0,-80,-80],[-120,0,-90],[-120,0,90],[0,0,100],[160,0,80],[160,0,-80],[0,0,-100]],
    f:[{v:[17,19,29],s:"hull_sides"},{v:[17,27,29],s:"hull_sides"},{v:[18,28,30],s:"hull_sides"},{v:[18,20,30],s:"hull_sides"},{v:[21,23,31],s:"hull_sides"},{v:[21,31,33],s:"hull_sides"},{v:[22,32,34],s:"hull_sides"},{v:[22,24,32],s:"hull_sides"},{v:[17,19,21],s:"track_sides"},{v:[17,21,23],s:"track_sides"},{v:[18,20,22],s:"track_sides"},{v:[18,22,24],s:"track_sides"},{v:[1,17,27],s:"hull_sides"},{v:[1,5,27],s:"hull_sides"},{v:[4,8,28],s:"hull_sides"},{v:[4,18,28],s:"hull_sides"},{v:[15,16,25],s:"hull_top"},{v:[16,25,26],s:"hull_top"},{v:[7,35,36],s:"turret_hull_top"},{v:[6,7,35],s:"turret_hull_top"},{v:[2,6,23],s:"hull_sides"},{v:[6,23,31],s:"hull_sides"},{v:[3,24,32],s:"hull_sides"},{v:[3,7,32],s:"hull_sides"},{v:[1,17,23],s:"track_sides"},{v:[1,2,23],s:"track_sides"},{v:[4,18,24],s:"track_sides"},{v:[3,4,24],s:"track_sides"},{v:[3,4,8],s:"hull_top"},{v:[3,7,8],s:"hull_top"},{v:[1,2,5],s:"hull_top"},{v:[2,5,6],s:"hull_top"},{v:[10,15,16],s:"hull_top"},{v:[9,10,15],s:"hull_top"},{v:[9,10,12],s:"hull_top"},{v:[9,11,12],s:"hull_top"},{v:[7,13,14],s:"hull_top"},{v:[6,7,13],s:"hull_top"},{v:[6,9,13],s:"hull_top"},{v:[9,11,13],s:"hull_top"},{v:[7,10,14],s:"hull_top"},{v:[10,12,14],s:"hull_top"},{v:[11,12,14],s:"hull_top"},{v:[11,13,14],s:"hull_top"},{v:[40,46,47],s:"turret_hull_sides"},{v:[40,41,47],s:"turret_hull_sides"}],
    t:37
  },
  'KV-85':{
    v:[[0,0,0],[-300,40,170],[400,40,170],[400,40,-170],[-300,40,-170],[-300,40,100],[400,40,100],[400,40,-100],[-300,40,-100],[-200,40,100],[-200,40,-100],[-170,0,100],[-170,0,-100],[380,0,100],[380,0,-100],[-300,60,100],[-300,60,-100],[-280,140,170],[-280,140,-170],[-180,180,170],[-180,180,-170],[260,180,170],[260,180,-170],[380,140,170],[380,140,-170],[-260,140,100],[-260,140,-100],[-280,140,100],[-280,140,-100],[-180,180,100],[-180,180,-100],[380,140,100],[380,140,-100],[260,180,100],[260,180,-100],[340,140,100],[340,140,-100],[-100,-80,-70],[-100,-80,70],[0,-80,80],[140,-80,70],[140,-80,-70],[0,-80,-80],[-120,0,-90],[-120,0,90],[0,0,100],[160,0,80],[160,0,-80],[0,0,-100]],
    f:[{v:[17,19,29],s:"hull_sides"},{v:[17,27,29],s:"hull_sides"},{v:[18,28,30],s:"hull_sides"},{v:[18,20,30],s:"hull_sides"},{v:[21,23,31],s:"hull_sides"},{v:[21,31,33],s:"hull_sides"},{v:[22,32,34],s:"hull_sides"},{v:[22,24,32],s:"hull_sides"},{v:[17,19,21],s:"track_sides"},{v:[17,21,23],s:"track_sides"},{v:[18,20,22],s:"track_sides"},{v:[18,22,24],s:"track_sides"},{v:[1,17,27],s:"hull_sides"},{v:[1,5,27],s:"hull_sides"},{v:[4,8,28],s:"hull_sides"},{v:[4,18,28],s:"hull_sides"},{v:[15,16,25],s:"hull_top"},{v:[16,25,26],s:"hull_top"},{v:[7,35,36],s:"turret_hull_top"},{v:[6,7,35],s:"turret_hull_top"},{v:[2,6,23],s:"hull_sides"},{v:[6,23,31],s:"hull_sides"},{v:[3,24,32],s:"hull_sides"},{v:[3,7,32],s:"hull_sides"},{v:[1,17,23],s:"track_sides"},{v:[1,2,23],s:"track_sides"},{v:[4,18,24],s:"track_sides"},{v:[3,4,24],s:"track_sides"},{v:[3,4,8],s:"hull_top"},{v:[3,7,8],s:"hull_top"},{v:[1,2,5],s:"hull_top"},{v:[2,5,6],s:"hull_top"},{v:[10,15,16],s:"hull_top"},{v:[9,10,15],s:"hull_top"},{v:[9,10,12],s:"hull_top"},{v:[9,11,12],s:"hull_top"},{v:[7,13,14],s:"hull_top"},{v:[6,7,13],s:"hull_top"},{v:[6,9,13],s:"hull_top"},{v:[9,11,13],s:"hull_top"},{v:[7,10,14],s:"hull_top"},{v:[10,12,14],s:"hull_top"},{v:[11,12,14],s:"hull_top"},{v:[11,13,14],s:"hull_top"},{v:[40,46,47],s:"turret_hull_sides"},{v:[40,41,47],s:"turret_hull_sides"}],
    t:37
  },
  'JS II':{
    v:[[0,0,0],[-300,30,160],[420,60,160],[420,60,-160],[-300,30,-160],[-300,30,80],[-300,30,-80],[-180,30,80],[-180,30,-80],[-60,30,140],[-60,30,-140],[380,30,-140],[380,30,140],[380,30,-160],[380,30,160],[-60,0,120],[340,0,120],[340,0,-120],[-60,0,-120],[-180,0,-40],[-180,0,40],[-240,30,80],[-240,30,-80],[-280,50,-80],[-280,50,80],[-280,50,160],[-280,50,-160],[-280,100,160],[-280,100,-160],[-180,140,160],[-180,140,-160],[300,140,160],[300,140,-160],[380,100,160],[380,100,-160],[380,100,80],[380,100,-80],[-240,100,80],[-240,100,-80],[-280,100,80],[-280,100,-80],[-180,140,80],[-180,140,-80],[420,60,-80],[420,60,80],[340,140,-80],[340,140,80],[-60,30,160],[-60,30,-160],[-140,-100,-60],[-140,-100,60],[0,-110,80],[120,-100,60],[140,-100,0],[120,-100,-60],[0,-110,-80],[-160,0,-60],[-160,0,60],[0,0,120],[140,0,100],[160,0,0],[140,0,-100],[0,0,-120]],
    f:[{v:[27,29,41],s:"turret_hull_sides"},{v:[27,39,41],s:"turret_hull_sides"},{v:[28,30,42],s:"turret_hull_sides"},{v:[28,40,42],s:"turret_hull_sides"},{v:[32,34,36],s:"turret_hull_sides"},{v:[32,36,45],s:"turret_hull_sides"},{v:[31,33,35],s:"turret_hull_sides"},{v:[31,45,46],s:"turret_hull_sides"},{v:[29,31,33],s:"track_sides"},{v:[27,29,33],s:"track_sides"},{v:[30,32,34],s:"track_sides"},{v:[28,30,34],s:"track_sides"},{v:[1,27,39],s:"turret_hull_sides"},{v:[1,5,39],s:"turret_hull_sides"},{v:[6,28,40],s:"turret_hull_sides"},{v:[4,6,28],s:"hull_sides"},{v:[23,24,37],s:"turret_hull_top"},{v:[23,37,38],s:"turret_hull_top"},{v:[36,43,44],s:"turret_hull_top"},{v:[35,36,44],s:"turret_hull_top"},{v:[13,43,34],s:"turret_hull_sides"},{v:[34,36,43],s:"turret_hull_sides"},{v:[14,33,44],s:"turret_hull_sides"},{v:[33,35,44],s:"turret_hull_sides"},{v:[14,27,33],s:"track_sides"},{v:[1,14,27],s:"track_sides"},{v:[13,28,34],s:"track_sides"},{v:[4,13,28],s:"track_sides"},{v:[4,6,8],s:"hull_top"},{v:[4,8,10],s:"hull_top"},{v:[1,5,7],s:"hull_top"},{v:[1,7,9],s:"hull_top"},{v:[1,9,47],s:"turret_hull_top"},{v:[4,10,48],s:"turret_hull_top"},{v:[10,11,13],s:"hull_top"},{v:[10,13,48],s:"turret_hull_top"},{v:[9,14,47],s:"turret_hull_top"},{v:[9,12,14],s:"hull_top"},{v:[21,22,24],s:"hull_top"},{v:[22,23,24],s:"hull_top"},{v:[3,11,12],s:"hull_top"},{v:[2,3,12],s:"hull_top"},{v:[2,12,14],s:"hull_top"},{v:[2,11,13],s:"hull_top"},{v:[19,20,21],s:"hull_top"},{v:[19,21,22],s:"hull_top"},{v:[8,19,22],s:"hull_top"},{v:[7,20,21],s:"hull_top"},{v:[7,9,20],s:"hull_top"},{v:[9,15,20],s:"hull_top"},{v:[8,10,19],s:"hull_top"},{v:[10,18,19],s:"hull_top"},{v:[10,17,18],s:"hull_top"},{v:[10,11,17],s:"hull_top"},{v:[9,15,16],s:"hull_top"},{v:[9,12,16],s:"hull_top"},{v:[12,16,17],s:"hull_top"},{v:[11,12,17],s:"hull_top"},{v:[15,16,18],s:"hull_top"},{v:[16,17,18],s:"hull_top"},{v:[15,18,19],s:"hull_top"},{v:[15,19,20],s:"hull_top"},{v:[55,61,62],s:"turret_hull_sides"},{v:[54,55,61],s:"turret_hull_sides"}],
    t:49
  },

  // ── Mercenary tanks — hand-crafted geometry, unique silhouettes per class ────
  // Shared face topology (indices 1-16, t=17); proportions + turret verts vary.
  // neg orig_x = front (gun direction), pos orig_x = rear; orig_y 0=deck pos=down.
  'Marauder Mk II':{
    // 17-20: track inner bottom (same y as outer, z slightly inward → creates visible track width)
    // 21-29: turret verts (shifted from old 17-25); t=21
    v:[[0,0,0],[-200,0,140],[-200,0,-140],[160,0,140],[160,0,-140],[-260,60,160],[-260,60,-160],[180,60,175],[180,60,-175],[-240,100,180],[-240,100,-180],[180,100,180],[180,100,-180],[-60,0,80],[-60,0,-80],[60,0,80],[60,0,-80],[-240,100,145],[-240,100,-145],[180,100,145],[180,100,-145],[-80,-45,65],[-80,-45,-65],[60,-45,65],[60,-45,-65],[-80,0,65],[-80,0,-65],[60,0,65],[60,0,-65],[-100,-20,0]],
    f:[{v:[1,2,14],s:"hull_top"},{v:[1,13,14],s:"hull_top"},{v:[1,3,13],s:"hull_top"},{v:[3,13,15],s:"hull_top"},{v:[2,4,14],s:"hull_top"},{v:[4,14,16],s:"hull_top"},{v:[3,4,16],s:"hull_top"},{v:[3,15,16],s:"hull_top"},{v:[13,14,16],s:"turret_hull_top"},{v:[13,15,16],s:"turret_hull_top"},{v:[1,2,5],s:"hull_sides"},{v:[2,5,6],s:"hull_sides"},{v:[1,3,5],s:"hull_sides"},{v:[3,5,7],s:"hull_sides"},{v:[2,4,6],s:"hull_sides"},{v:[4,6,8],s:"hull_sides"},{v:[3,4,7],s:"hull_sides"},{v:[4,7,8],s:"hull_sides"},{v:[5,7,9],s:"track_sides"},{v:[7,9,11],s:"track_sides"},{v:[6,8,10],s:"track_sides"},{v:[8,10,12],s:"track_sides"},{v:[5,7,17],s:"track_sides"},{v:[7,17,19],s:"track_sides"},{v:[6,8,18],s:"track_sides"},{v:[8,18,20],s:"track_sides"},{v:[9,11,17],s:"track_sides"},{v:[11,17,19],s:"track_sides"},{v:[10,12,18],s:"track_sides"},{v:[12,18,20],s:"track_sides"},{v:[5,9,17],s:"track_sides"},{v:[6,10,18],s:"track_sides"},{v:[7,11,19],s:"track_sides"},{v:[8,12,20],s:"track_sides"}],
    t:21
  },
  'Interceptor':{
    // 17-20: track inner bottom (z=108, inward from hull-lower z=120/130 and outer z=140)
    // 21-29: turret verts (shifted); t=21
    v:[[0,0,0],[-280,0,100],[-280,0,-100],[220,0,100],[220,0,-100],[-330,50,120],[-330,50,-120],[240,50,130],[240,50,-130],[-310,90,140],[-310,90,-140],[240,90,140],[240,90,-140],[-160,0,65],[-160,0,-65],[-10,0,65],[-10,0,-65],[-310,90,108],[-310,90,-108],[240,90,108],[240,90,-108],[-180,-75,50],[-180,-75,-50],[-10,-75,50],[-10,-75,-50],[-180,0,50],[-180,0,-50],[-10,0,50],[-10,0,-50],[-200,-35,0]],
    f:[{v:[1,2,14],s:"hull_top"},{v:[1,13,14],s:"hull_top"},{v:[1,3,13],s:"hull_top"},{v:[3,13,15],s:"hull_top"},{v:[2,4,14],s:"hull_top"},{v:[4,14,16],s:"hull_top"},{v:[3,4,16],s:"hull_top"},{v:[3,15,16],s:"hull_top"},{v:[13,14,16],s:"turret_hull_top"},{v:[13,15,16],s:"turret_hull_top"},{v:[1,2,5],s:"hull_sides"},{v:[2,5,6],s:"hull_sides"},{v:[1,3,5],s:"hull_sides"},{v:[3,5,7],s:"hull_sides"},{v:[2,4,6],s:"hull_sides"},{v:[4,6,8],s:"hull_sides"},{v:[3,4,7],s:"hull_sides"},{v:[4,7,8],s:"hull_sides"},{v:[5,7,9],s:"track_sides"},{v:[7,9,11],s:"track_sides"},{v:[6,8,10],s:"track_sides"},{v:[8,10,12],s:"track_sides"},{v:[5,7,17],s:"track_sides"},{v:[7,17,19],s:"track_sides"},{v:[6,8,18],s:"track_sides"},{v:[8,18,20],s:"track_sides"},{v:[9,11,17],s:"track_sides"},{v:[11,17,19],s:"track_sides"},{v:[10,12,18],s:"track_sides"},{v:[12,18,20],s:"track_sides"},{v:[5,9,17],s:"track_sides"},{v:[6,10,18],s:"track_sides"},{v:[7,11,19],s:"track_sides"},{v:[8,12,20],s:"track_sides"}],
    t:21
  },
  'Vulture Type I':{
    // 17-20: track inner bottom (z=185, inward from hull-lower z=200 and outer z=220)
    // 21-29: turret verts (shifted); t=21
    v:[[0,0,0],[-180,0,140],[-180,0,-140],[200,0,140],[200,0,-140],[-250,80,200],[-250,80,-200],[220,80,200],[220,80,-200],[-230,120,220],[-230,120,-220],[220,120,220],[220,120,-220],[-80,0,100],[-80,0,-60],[60,0,100],[60,0,-60],[-230,120,185],[-230,120,-185],[220,120,185],[220,120,-185],[-100,-50,110],[-100,-50,-70],[60,-50,110],[60,-50,-70],[-100,0,110],[-100,0,-70],[60,0,110],[60,0,-70],[-120,-20,20]],
    f:[{v:[1,2,14],s:"hull_top"},{v:[1,13,14],s:"hull_top"},{v:[1,3,13],s:"hull_top"},{v:[3,13,15],s:"hull_top"},{v:[2,4,14],s:"hull_top"},{v:[4,14,16],s:"hull_top"},{v:[3,4,16],s:"hull_top"},{v:[3,15,16],s:"hull_top"},{v:[13,14,16],s:"turret_hull_top"},{v:[13,15,16],s:"turret_hull_top"},{v:[1,2,5],s:"hull_sides"},{v:[2,5,6],s:"hull_sides"},{v:[1,3,5],s:"hull_sides"},{v:[3,5,7],s:"hull_sides"},{v:[2,4,6],s:"hull_sides"},{v:[4,6,8],s:"hull_sides"},{v:[3,4,7],s:"hull_sides"},{v:[4,7,8],s:"hull_sides"},{v:[5,7,9],s:"track_sides"},{v:[7,9,11],s:"track_sides"},{v:[6,8,10],s:"track_sides"},{v:[8,10,12],s:"track_sides"},{v:[5,7,17],s:"track_sides"},{v:[7,17,19],s:"track_sides"},{v:[6,8,18],s:"track_sides"},{v:[8,18,20],s:"track_sides"},{v:[9,11,17],s:"track_sides"},{v:[11,17,19],s:"track_sides"},{v:[10,12,18],s:"track_sides"},{v:[12,18,20],s:"track_sides"},{v:[5,9,17],s:"track_sides"},{v:[6,10,18],s:"track_sides"},{v:[7,11,19],s:"track_sides"},{v:[8,12,20],s:"track_sides"}],
    t:21
  },
  'Obliterator IV':{
    // 17-20: track inner bottom (z=148, inward from hull-lower z=160 and outer z=178)
    // 21-29: turret verts (shifted); t=21
    v:[[0,0,0],[-220,0,145],[-220,0,-145],[260,0,145],[260,0,-145],[-280,90,160],[-280,90,-160],[280,90,160],[280,90,-160],[-260,130,178],[-260,130,-178],[280,130,178],[280,130,-178],[-80,0,100],[-80,0,-100],[80,0,100],[80,0,-100],[-260,130,148],[-260,130,-148],[280,130,148],[280,130,-148],[-140,-80,95],[-140,-80,-95],[80,-80,95],[80,-80,-95],[-140,0,95],[-140,0,-95],[80,0,95],[80,0,-95],[-160,-40,0]],
    f:[{v:[1,2,14],s:"hull_top"},{v:[1,13,14],s:"hull_top"},{v:[1,3,13],s:"hull_top"},{v:[3,13,15],s:"hull_top"},{v:[2,4,14],s:"hull_top"},{v:[4,14,16],s:"hull_top"},{v:[3,4,16],s:"hull_top"},{v:[3,15,16],s:"hull_top"},{v:[13,14,16],s:"turret_hull_top"},{v:[13,15,16],s:"turret_hull_top"},{v:[1,2,5],s:"hull_sides"},{v:[2,5,6],s:"hull_sides"},{v:[1,3,5],s:"hull_sides"},{v:[3,5,7],s:"hull_sides"},{v:[2,4,6],s:"hull_sides"},{v:[4,6,8],s:"hull_sides"},{v:[3,4,7],s:"hull_sides"},{v:[4,7,8],s:"hull_sides"},{v:[5,7,9],s:"track_sides"},{v:[7,9,11],s:"track_sides"},{v:[6,8,10],s:"track_sides"},{v:[8,10,12],s:"track_sides"},{v:[5,7,17],s:"track_sides"},{v:[7,17,19],s:"track_sides"},{v:[6,8,18],s:"track_sides"},{v:[8,18,20],s:"track_sides"},{v:[9,11,17],s:"track_sides"},{v:[11,17,19],s:"track_sides"},{v:[10,12,18],s:"track_sides"},{v:[12,18,20],s:"track_sides"},{v:[5,9,17],s:"track_sides"},{v:[6,10,18],s:"track_sides"},{v:[7,11,19],s:"track_sides"},{v:[8,12,20],s:"track_sides"}],
    t:21
  }
};
// ── Coordinate transform ───────────────────────────────────────────────────────
// orig(x=fwd, y=screen-down, z=right) → Three.js(x=right, y=up, z=fwd)
// ty requires per-tank maxY and is computed inline: (maxY - v[1]) * VERT_SCALE
function tx(v) { return  v[2] * VERT_SCALE; }
function tz(v) { return  v[0] * VERT_SCALE; }

// ── Build a face-based BufferGeometry mesh ─────────────────────────────────────
// forTurret: true → only turret faces; false → only hull faces
// mat: THREE.Material instance to use (one per tank, for independent charring)
// ox, oz: XZ offset to subtract (for turret pivot repositioning)
// oy: Y offset to subtract (tcy for turret so verts are in turretGroup local space)
function buildFaceMesh(faces, verts, turret_start, forTurret, mat, ox, oz, maxY, oy = 0, surfFilter = null) {
  const pos = [];

  for (const face of faces) {
    const { v, s } = face;
    const isTurret = v.some(vi => vi >= turret_start);
    if (forTurret !== isTurret) continue;
    if (surfFilter !== null && !surfFilter(s)) continue;

    for (const vi of v) {
      const vert = verts[vi];
      pos.push(tx(vert) - ox, (maxY - vert[1]) * VERT_SCALE - oy, tz(vert) - oz);
    }
  }

  if (pos.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();

  return new THREE.Mesh(geo, mat);
}


// ── Public builder ────────────────────────────────────────────────────────────
// Returns { grp, turretGroup, muzzleDist, muzzleHeight, hitRadius }
export function buildAuthenticModel(def, defKey, isEnemy = false) {
  const modelName = DEF_TO_MODEL[defKey] ?? 'Sherman Firefly';
  const { v: verts, f: faces, t: turret_start } = MODEL_DATA[modelName];
  const baseHex = BASE_COLORS[def.faction] ?? BASE_COLORS.american;
  const base    = new THREE.Color(baseHex);

  // Per-tank material instances so each hull can be charred independently
  const hullMat  = makeMat();
  const trackMat = makeMat();

  // Compute maxY for Y-axis inversion (orig Y-down: 0=hull-top, max=track level)
  // Only hull verts (indices < turret_start) determine maxY; turret verts have neg Y
  let maxY = 0;
  for (let i = 0; i < turret_start; i++) {
    if (verts[i][1] > maxY) maxY = verts[i][1];
  }

  // Turret pivot height: hull-deck level in Three.js local space
  const tcy = maxY * VERT_SCALE;

  const isTrack = s => s === 'track_sides' || s === 'turret_track_sides';

  // Hull centroid Y in Three.js space: midpoint between track bottom (Y=0) and top deck (Y=maxY*VERT_SCALE)
  const hullModelCy = maxY * VERT_SCALE / 2;

  const grp = new THREE.Group();

  // ── Hull mesh (non-track hull faces) ──────────────────────────────────────
  const hullMesh = buildBakedMesh(faces, verts, turret_start, false, base, hullMat, 0, 0, maxY, 0, s => !isTrack(s), null, hullModelCy);
  if (hullMesh) grp.add(hullMesh);

  // ── Track mesh (track_sides / turret_track_sides) ─────────────────────────
  // Dark steel grey — same material for all factions, not a tint of the hull colour.
  // forcedBrightness=1.0 means TRACK_COLOR is used exactly as-is (no dot/quantise).
  const trackMesh = buildBakedMesh(faces, verts, turret_start, false, TRACK_COLOR, trackMat, 0, 0, maxY, 0, isTrack, 1.0);
  if (trackMesh) grp.add(trackMesh);

  // ── Turret pivot: XZ centroid of turret-specific vertices ─────────────────
  let tcx = 0, tcz = 0, tcyn = 0, n = 0;
  for (let vi = turret_start; vi < verts.length; vi++) {
    const v = verts[vi];
    tcx  += tx(v);
    tcz  += tz(v);
    tcyn += (maxY - v[1]) * VERT_SCALE;
    n++;
  }
  if (n > 0) { tcx /= n; tcz /= n; tcyn /= n; }

  const turretGroup = new THREE.Group();
  turretGroup.position.set(tcx, tcy, tcz);
  grp.add(turretGroup);

  // ── Turret mesh: ConvexGeometry from turret vertices ─────────────────────
  if (verts.length > turret_start) {
    const pts = [];
    for (let vi = turret_start; vi < verts.length; vi++) {
      const v = verts[vi];
      pts.push(new THREE.Vector3(tx(v) - tcx, (maxY - v[1]) * VERT_SCALE - tcy, tz(v) - tcz));
    }
    if (pts.length >= 4) {
      const convexGeo = new ConvexGeometry(pts);
      const turretMat = makeMat();
      turretGroup.add(bakeConvexMesh(convexGeo, base, turretMat));
      convexGeo.dispose();
    }
  }

  // ── Gun barrel ────────────────────────────────────────────────────────────
  // Frontmost turret vertex in Three.js is most negative Z (orig -X → tz = +orig_x, so min orig_x → min tz)
  let minTZ_hull = Infinity;   // min tz() of turret verts, in hull space
  for (let vi = turret_start; vi < verts.length; vi++) {
    const z = tz(verts[vi]);
    if (z < minTZ_hull) minTZ_hull = z;
  }
  const minTZ_local = minTZ_hull - tcz;  // in turretGroup local space

  const gunLen = 0.60 + def.firepower / 100 * 0.90;
  const gunGeo = new THREE.CylinderGeometry(0.055, 0.055, gunLen, 6);
  const gun    = new THREE.Mesh(gunGeo, GUN_MAT);
  gun.rotation.x = Math.PI / 2;
  // Gun Y in turretGroup local space: tcyn is world Y, tcy is pivot Y
  gun.position.set(0, tcyn - tcy, minTZ_local - gunLen * 0.5);
  turretGroup.add(gun);

  // ── Values exposed to combat.js ──────────────────────────────────────────
  // muzzleHeight = gun world Y relative to tank hull base = tcyn
  const muzzleDist   = -(minTZ_hull - gunLen);
  const muzzleHeight =   tcyn;

  // ── Hull extents for hit radius ───────────────────────────────────────────
  let maxX = 0, maxZ = 0;
  for (let i = 0; i < turret_start; i++) {
    const ax = Math.abs(tx(verts[i]));
    const az = Math.abs(tz(verts[i]));
    if (ax > maxX) maxX = ax;
    if (az > maxZ) maxZ = az;
  }
  const hitRadius = Math.max(maxX, maxZ) * 0.85;

  return { grp, turretGroup, muzzleDist, muzzleHeight, hitRadius };
}
