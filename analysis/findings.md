# Conqueror — Binary Analysis Findings
## Original Game: Conqueror, Superior Software, 1988
## Platform: Acorn Archimedes (RISC OS), ARM2 processor
## Analysed file: `!Conqueror/!RunImage,8000-ef4c` — ARM binary, 242 KB

---

## File Inventory

| File | Size | Type | Notes |
|------|------|------|-------|
| `!RunImage,8000-ef4c` | 242 KB | ARM binary | Main game executable. Load addr 0x8000, exec addr 0xEF4C |
| `!Sprites,ff9` | — | RISC OS sprite file | Sprite graphics (filetype FF9 = sprite) |
| `!Help.txt` | small | Text | Fan-written gameplay hints |
| `!Run,feb` | tiny | RISC OS Obey file | Launcher script (filetype FEB = Obey) |
| `MemAlloc,ffa` | — | Module | Memory allocator helper module |

---

## Tank Data Structure

### Location in binary
Tank records begin at binary offset **0x0BB8** (decimal 3000).

### Record format
Each tank record is **128 bytes (0x80)** wide, giving 12 records total.

```
Offset  Size  Description
------  ----  -----------
+0x00   4     Header / type tag
+0x04   16    Tank name (ASCII, null-padded)
+0x14   1     Null terminator after name (name_end)
+0x15   ...   Stat bytes (see below)
```

### Stat byte offsets
The ARM disassembly contains `LDRB R0, [R12, #offset]` instructions for each
displayed stat. R12 points to **name_start + 1** (the byte after the 4-byte header,
i.e., the first byte of the name field), so the absolute position in the record is:

```
Stat                  R12 offset   Record offset   Notes
--------------------  ----------   -------------   -----
Frontal Armour        +0x12        +0x13 (19)      0–200 scale
Side Armour           +0x13        +0x14 (20)      0–200 scale
Rear Armour           +0x14        +0x15 (21)      0–200 scale
Max Penetration       +0x17        +0x18 (24)      firepower equiv.
Max Road Speed        +0x1B        +0x1C (28)      literal km/h
Max X-Country Speed   +0x1C        +0x1D (29)      literal km/h
```

---

## Extracted Tank Stats (raw from binary)

All 12 original tanks, stats as read directly from the binary:

| Tank             | FrontArm | SideArm | RearArm | Penetration | Road km/h | XC km/h |
|------------------|----------|---------|---------|-------------|-----------|---------|
| Panzer III       | 55       | 30      | 40      | 59          | 40        | 25      |
| Panther          | 120      | 57      | 46      | 124         | 46        | 25      |
| Tiger I          | 110      | 80      | 80      | 110         | 38        | 20      |
| King Tiger       | 200      | 90      | 90      | 185         | 35        | 20      |
| M24 Chaffee      | 40       | 20      | 19      | 70          | 56        | 40      |
| M36 90mmGMC      | 60       | 22      | 20      | 135         | 48        | 29      |
| Sherman Firefly  | 93       | 38      | 38      | 121         | 40        | 25      |
| M26 Pershing     | 120      | 76      | 51      | 135         | 32        | 20      |
| T-34/76          | 73       | 60      | 40      | 69          | 55        | 38      |
| KV-1S            | 86       | 60      | 40      | 69          | 45        | 30      |
| KV-85            | 86       | 60      | 40      | 96          | 40        | 26      |
| JS-II            | 186      | 95      | 60      | 145         | 37        | 20      |

### Key historical cross-checks (confirms speeds are literal km/h)
- Tiger I road speed: 38 km/h ✓ (historical: 38 km/h)
- T-34/76 road speed: 55 km/h ✓ (historical: 55 km/h)
- JS-II road speed: 37 km/h ✓ (historical: 37 km/h)
- Tiger I ≈ Sherman Firefly in speed (38 vs 40) — matches historical reality

---

## Mapping to Game Config (config.js)

The original binary values are mapped to game stats as follows:

- `maxSpeed` = binary road km/h (direct, 1:1)
- `armour` = binary frontal armour ÷ 2 (scales 0–200 to 0–100 for damage formula)
- `firepower` = binary penetration ÷ 2 (same scale conversion)
- `reloadTime` = binary reload-time byte ÷ 10 (gives seconds; KingTiger=4.0s, Chaffee=0.9s)
- `accel`, `turnRate`, `turretSpeed`, `accuracy` — extrapolated from gameplay feel;
  no binary fields identified for these (possible candidates exist but unconfirmed)

---

## 3D Model Data

The binary contains **face/vertex data** for all 12 tank models. Each tank has two
meshes: hull and turret. The data is stored as compact face records with packed
vertex coordinates relative to a per-tank scale factor.

Model names in the browser port's `MODEL_DATA` constant in `models.js` correspond
directly to the original tank names. The `DEF_TO_MODEL` map links config keys
(e.g., `'tiger'`) to model names (e.g., `'Tiger I'`).

---

## Game Logic Notes

### Faction roster (original game)
- **German** (enemies): Panzer III, Panther, Tiger I, King Tiger
- **American** (player options): M24 Chaffee, M36 90mmGMC, Sherman Firefly, M26 Pershing
- **Russian** (player options): T-34/76, KV-1S, KV-85, JS-II

### Enemy roster in the port (all 3 waves vs German armour)
- Wave 1: Panzer III × 2, Panther, Tiger I
- Wave 2: Panther, Tiger I × 2, King Tiger
- Wave 3: Panther, Tiger I, King Tiger × 2

### Damage formula
`penetration > armour → hit kills; else → damage = max(1, fp - armour * 0.5)`
(approximation — exact formula not fully recovered from binary)

---

## Ambiguities / Extrapolations

| Item | Status | Notes |
|------|--------|-------|
| Accel / turnRate stats | Extrapolated | No binary fields positively identified; values tuned for feel |
| Turret speed stats | Extrapolated | No binary field found; relative ordering preserved |
| Accuracy stats | Extrapolated | No binary field found |
| XC speed effect on movement | Not yet implemented | Binary has separate XC speeds; currently unused |
| AI behaviour states | Extrapolated | Idle/Seeking/Engaging/Retreating states are reasonable but not verified |
| Map boundary size | Extrapolated | No map size data found in binary |
| Sound synthesis | Extrapolated | Web Audio API approximations; original used custom Archimedes sound chip |
| Terrain generation | Extrapolated | Fourier sine-wave terrain matches original feel; original algo unknown |
