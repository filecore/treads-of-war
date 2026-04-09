# Treads of War — Full Game Description (v4.8, 07-03-2026)

> A browser-based 3D tank combat game built with Three.js. Inspired by Conqueror (Superior Software, 1988, Acorn Archimedes). Playable at https://treads.togneri.net/treads/

---

## Technology Stack

- **Renderer**: Three.js (WebGL), flat-shaded polygon aesthetic — no textures on tanks or terrain
- **Language**: Vanilla ES modules (no build step, no framework)
- **Audio**: Web Audio API via a custom `AudioManager`
- **Networking**: WebSocket relay server (Node.js) for Online mode; hosted via Docker + nginx
- **Deployment**: nginx static file serving; relay in Docker Compose; deployed via rsync from WSL
- **Source files**: `src/js/` — `main.js`, `config.js`, `modes.js`, `tank.js`, `models.js`, `ai.js`, `combat.js`, `terrain.js`, `particles.js`, `audio.js`, `input.js`, `game.js`, `net.js`

---

## Visual Style

- Flat-shaded polygons throughout — no texture mapping on terrain or tanks
- WWII European summer colour palette: bright meadow greens, sandy shorelines, terracotta rooftops, cream stone walls, dunkelgelb yellow tanks
- Vertex-coloured sky sphere with gradient from deep blue zenith to horizon, matching distance fog
- Directional sun lighting baked into tank vertex colours; Lambert shading on scene objects (trees, roads, buildings)
- No anti-aliasing (deliberate retro look); pixel ratio capped at 2×
- Fog: `FOG_NEAR 300` / `FOG_FAR 800` world units, blue-grey haze

---

## World / Terrain

- Procedurally generated via six overlapping sine waves (Fourier terrain)
- Map: `±325` world units from origin (650×650 wu total)
- Altitude range approximately 14.5–25.5 wu; sea level at 17 — areas below are flat water
- Terrain regenerated with a new seed each game start
- **Chunk-streamed**: 11×11 grid of 8×8-tile chunks, loaded/unloaded as player moves
- **Water**: low-lying cells tracked in a grid; rendered blue; shown on minimap
- **Roads**: 3–4 procedurally generated roads per map (east-west, north-south, diagonal, occasional spur); terrain-following quad-strip meshes shown on minimap
- **Trees**: flat-shaded conifers (trunk + canopy), ~20% more per chunk in recent versions; collision detection against trunks; destructible (particles on hit)
- **Buildings**: flat-shaded cream walls + terracotta roofs; do not spawn on roads; minimum spacing enforced; non-destructible but provide cover
- **Map boundary**: dark solid planes just outside MAP_HALF create a "world edge" effect
- **Track marks**: persistent tyre-track decals left by all tanks as they move; cleared between battles
- **Crater decals**: ground craters from shell impacts and tank deaths; cleared between battles

---

## Tank Roster

16 tanks across 4 factions. Stats derived from original Conqueror Archimedes binary data.

### American (Allies)
| Tank | Speed | XC | Front | Fire | Reload | Cost |
|------|-------|----|-------|------|--------|------|
| M24 Chaffee | 62 km/h | 44 | 20 | 35 | 0.9s | 80 |
| M36 90mmGMC | 53 | 32 | 30 | 68 | 0.9s | 180 |
| Sherman Firefly | 44 | 28 | 47 | 61 | 1.3s | 220 |
| M26 Pershing | 35 | 22 | 60 | 68 | 1.3s | 400 |

### Russian (Soviets)
| Tank | Speed | XC | Front | Fire | Reload | Cost |
|------|-------|----|-------|------|--------|------|
| T-34/76 | 61 km/h | 42 | 37 | 35 | 3.0s | 120 |
| KV-1S | 50 | 33 | 43 | 35 | 3.0s | 160 |
| KV-85 | 44 | 29 | 43 | 48 | 3.0s | 220 |
| JS-II | 41 | 22 | 93 | 73 | 3.0s | 480 |

### German (Axis)
| Tank | Speed | XC | Front | Fire | Reload | Cost |
|------|-------|----|-------|------|--------|------|
| Panzer III | 44 km/h | 28 | 28 | 30 | 1.6s | 80 |
| Panther | 51 | 28 | 60 | 62 | 1.6s | 240 |
| Tiger I | 42 | 22 | 55 | 55 | 2.5s | 360 |
| King Tiger | 39 | 22 | 100 | 93 | 4.0s | 520 |

### Mercenary (unlockable, experimental)
| Tank | Speed | XC | Front | Fire | Reload | Cost |
|------|-------|----|-------|------|--------|------|
| Marauder Mk II | 55 km/h | 37 | 28 | 33 | 1.8s | 120 |
| Interceptor | 51 | 31 | 44 | 55 | 1.8s | 280 |
| Vulture Type I | 43 | 26 | 48 | 55 | 2.3s | 400 |
| Obliterator IV | 62 | 39 | 100 | 100 | 0.5s | 800 |

- Player reloads 25% faster than the config baseline
- Each faction faces the opposing faction's tanks as enemies (German vs Allied/Soviet, Allied/Soviet vs German)
- Mercenary faction is available via a Settings toggle; flagged as experimental / unbalanced

---

## Tank Model System

- All tanks rendered as flat-shaded Three.js geometry (hull box, turret box, gun barrel cylinder, track bars)
- Each tank has a `modelScale` multiplier — heavier tanks are visually larger
- Tank colours are faction-coded: American green, Soviet green (slightly different), German dunkelgelb yellow, Mercenary steel blue
- Obliterator IV has a fully custom visual editor (see Settings)
- Tank preview canvas shown on the menu screen (rotates the selected tank in isolation)
- Baked vertex-colour lighting — tanks look correctly shaded regardless of scene lights

---

## Combat System

- **AP shells**: armour-penetrating, direct damage based on firepower vs armour (front/side/rear)
- **HE shells**: available in Attrition and Strategy modes; splash damage radius 18 wu, max 30 damage; switched with `Tab`
- Shells follow ballistic arcs (gravity applied); visible as short cylinder tracers
- Damage is directional: frontal hits against front armour, flanking hits against side, rear hits hardest
- HP system: tanks have HP scaled from armour values; damage formula based on firepower/armour ratio
- **Speed damage states**: tanks progressively slow at low HP (Half speed → Quarter speed → Immobilised) shown in HUD
- **Aim assist**: optional gentle turret pull toward nearest enemy within 80 wu (25% default)
- **Gun-sight mode** (`V` key): zooms to 14° FOV with pointer-lock mouse control for precise long-range shots
- **Friendly fire**: toggle in Settings (on by default)
- **Shell pass-by sound**: triggered when an enemy shell passes within 20 wu of the player

---

## Player Abilities (Attrition & Strategy modes)

### Smoke Screen (`G`)
- Deploys a smoke cloud at the player's position
- 3 grenades per wave/battle, replenished on wave/battle start
- Cloud grows to 11 wu radius over 2.5s, persists 14s total, fades over final 4s
- Obscures enemy AI targeting — enemies cannot fire accurately through smoke

### Artillery Barrage (`C`)
- 2 charges per battle
- Click on minimap to target; 6 shells rain down within 22 wu radius after 1.8s delay
- Per-shell blast radius 11 wu, max 30 damage at ground zero
- HE splash rules apply (area denial, not precision)

### Spotter Plane (`X`) — Strategy mode only
- 2 charges per battle
- Reveals all enemy positions on the minimap for 25 seconds
- By default, enemy dots are hidden on the minimap in Strategy mode until spotted

---

## Supply Crates — Strategy mode only

Three crates spawn on the map at the start of each Strategy battle:

| Type | Colour | Effect |
|------|--------|--------|
| HP | Red `#DD3333` | +25 HP restored |
| Smoke | Blue `#2266EE` | Smoke ammo replenished |
| Artillery | Yellow `#DDAA11` | +1 artillery charge |

- Crates bob vertically and rotate slowly
- Collected by driving within 5 wu of the crate
- Each crate type has a canvas-drawn symbol on all four side faces (first aid cross, cloud, ballistic arc with shell)

---

## Game Modes

### Arcade
- **Endless waves, solo play, 3 lives**
- Player upgrades through 4 tank classes as they accumulate kills (4 kills per class)
- Class 0: light tanks (M24/T-34/Pz III/Marauder) — 2 enemies per wave
- Class 1: medium tanks — 3 enemies per wave
- Class 2: medium-heavy — 4 enemies per wave
- Class 3: heavy tanks (Pershing/JS-II/King Tiger/Obliterator) — starts at 3, grows by 1 each wave (endless)
- +30 HP repair between waves
- Score and kill count tracked throughout

### Attrition
- **Fixed squad of 5, permanent losses, escalating enemy**
- Player receives a pre-set faction squad at start (e.g. American: 2× M24, 2× Sherman, 1× Pershing)
- Destroyed player tanks are gone permanently — no replacements
- Enemy squads escalate each battle (4 preset escalation tiers; last tier repeats)
- Player switches between surviving squad tanks with `Q`/`E` keys
- Surviving tanks carry their damage into the next battle
- AP and HE ammo available; smoke available
- Win condition: destroy all enemies in each battle; survive as long as possible

### Strategy
- **Budget purchase screen before each battle, objective capture win condition**
- 7 escalating budget levels: 1000, 2000, 3375, 3000, 4000, 5000, 6000 pts
- Player purchases any mix of up to 8 tanks from their faction's full roster within budget
- AI opponent also purchases a squad (heaviest affordable tanks first, within same budget)
- Win by holding the objective ring (18 wu radius) continuously for 60 seconds
- Enemy within 35 wu of objective contests the hold
- Objective ring pulses slowly (6× slower than original ~1 Hz); very low opacity
- A vertical beacon column marks the objective from a distance
- All three special abilities available (smoke, artillery, spotter)
- Supply crates spawn on map
- Enemy positions hidden from minimap until spotted
- Score, kills, and level tracked across battles

### Online (beta)
- **Up to 16 players (8v8), cooperative or versus, over the internet/LAN**
- WebSocket relay server handles room discovery and message routing
- Host runs authoritative simulation at 60 fps, broadcasts at 20 Hz
- Client runs local prediction (smooth movement + server correction)
- Any tank from any faction selectable, including Mercenaries
- 4 team colours: Gold (0), Blue (1), Red (2), Green (3) — auto-assigned or manual
- Room codes (4 characters), host sets max player count and starts game
- Enemy shells visible as team-coloured tracers with between-snapshot interpolation
- Player name tags displayed above tanks
- Ping shown in HUD
- Find Games button scans relay for open rooms
- No lives system — death shows Defeat screen immediately

---

## AI System

### Enemy AI (`AIController`)
- States: IDLE → SEEKING → ENGAGING → RETREATING
- Flanking: each enemy AI assigned a unique approach angle around the player
- Fire-and-move cycle: advance → halt → fire → advance
- Reaction delay before turret starts tracking new target
- Difficulty scaling via 4 presets (Easy/Normal/Medium/Hard):
  - Detect range: 150–300 wu
  - Engage range: 70–130 wu
  - Aim tolerance: 0.55–0.18 radians
  - Fire interval: 2.3–7.0s
  - Turret speed multiplier: 0.30–1.05×
  - Player damage multiplier: 0.45–1.20×

### Friendly AI (`WingmanController`)
- Allies patrol around their spawn position when no enemies in range
- Within engage range (110 wu): patrol rather than stand still
- Turret tracks and fires at nearest enemy with accuracy spread
- Movement via direct `leftSpeed`/`rightSpeed` assignment (not the input system)
- `AI DISABLE` debug toggle freezes both enemy and friendly AI; friendly speeds explicitly zeroed

---

## HUD

- **Top-left**: HP bar, speed damage label, faction/tank name, ammo type (AP/HE)
- **Top-right**: smoke count, artillery count, spotter count (Strategy), score/kills/wave (advanced mode), ping (Online)
- **Minimap** (bottom-right, 210×210 px): roads, water, player dot (white triangle with FOV cone), enemy dots (red; hidden in Strategy without spotter), friendly dots (green), objective marker (yellow), crate dots (type-coloured)
- **Hit indicator**: flashes the name of what was hit (tank name, zone) at screen top
- **Edge-of-map warning**: shown when approaching boundary
- **Damage flash**: red vignette on player hit
- **Encounter message**: shown when player closes within 200 wu of a new enemy
- **Death camera**: 4-second orbit (radius 30, height 18) around wreck before game-over overlay
- **Squad HUD**: shows all squad tanks with HP bars in Attrition/Strategy modes, highlights active tank

---

## Settings Panel (tabbed)

### Settings tab
- Simple controls toggle (default on)
- Aim assist toggle
- Advanced HUD info toggle (score/kills/fps/ping visible)
- Friendly fire toggle (default on)
- Demo mode toggle
- Water toggle
- Mouse aim toggle (LMB fires, mouse steers turret)
- Mercenaries toggle
- Merc Editor toggle (unlocks Obliterator visual/stat editor)
- Online mode toggle (shows/hides Online option in mode list)
- Debug mode toggle
- Difficulty slider (Easy / Normal / Medium / Hard)
- Reset to defaults button

### Controls tab
- Full keyboard reference

### Help & FAQ tab
- Game overview, mode descriptions, tips

### Changelog tab
- Full version history (v4.0–v4.8)

---

## Obliterator IV Editor (Merc Editor)

Available when Mercs and Merc Editor are enabled in Settings. Opens from the tank selection screen.

- Custom designation (name field, up to 24 chars)
- All combat stats adjustable: front/side/rear armour, firepower, reload time, turret speed, accuracy
- All mobility stats adjustable: top speed, XC speed, acceleration, turn rate
- Visual transforms per part:
  - Body: width/length scale, height scale, vertical raise
  - Turret: width/length scale, height scale, vertical raise
  - Gun barrel: length multiplier, radius multiplier
- Reset to defaults button
- All changes persist in `localStorage` (`treads_obliterator_v1`)

---

## Debug Mode

Available via Settings toggle during gameplay:

- Panel displayed on right side of screen during `STATES.PLAYING`
- **AI DISABLE** button: freezes both enemy and friendly AI (enemies stop moving/firing; wingmen stop too)
- Live stat adjusters for player tank: top speed, XC speed, acceleration, turn rate, front/side/rear armour, firepower, reload time
- Changes take effect immediately on the live player tank

---

## Particle System

- Muzzle flash (bright cone at gun barrel tip)
- Shell impact sparks
- Explosion particles (tank death: large burst)
- Tree destruction particles (darkened debris)
- Smoke cloud (expanding sphere, opacity fades)
- Artillery impact particles

---

## Audio

- Engine sounds (pitch-scaled by speed)
- Gun fire
- Shell impact
- Explosion
- Shell pass-by (stereo panning based on direction)
- All via Web Audio API

---

## Keyboard Controls (default)

| Key | Action |
|-----|--------|
| W / Up | Accelerate forward |
| S / Down | Reverse |
| A / Left | Turn left |
| D / Right | Turn right |
| Space | Fire |
| Q / E | Switch tank (squad modes) |
| Tab | Switch ammo AP/HE (Attrition/Strategy) |
| V | Gun-sight mode (hold) |
| G | Smoke screen (Attrition/Strategy) |
| C | Artillery barrage (Strategy) |
| X | Spotter plane (Strategy) |
| P | Pause |
| R | Next wave / continue (wave complete screen) |
| Arrow keys | Navigate menus |
| Enter | Start game from menu |

---

## Known Gaps / Areas Not Fully Implemented

- Online mode is beta: tank colours may show host colour on client; some nametag edge cases; grey stray geometry possible
- Mercenaries are flagged experimental and not balanced for competitive play
- No campaign story, no mission briefings
- No persistent player progression across browser sessions (beyond Obliterator editor settings)
- No sound for smoke deploy, spotter call, crate collection
- Minimap does not show buildings
- No weather effects
- No night/lighting variation
