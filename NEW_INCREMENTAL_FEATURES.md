# Treads of War — New Features Spec

Four features to implement in order. Each is self-contained — complete one before starting the next.

---

## Feature 1: Ricochet System

### Concept

Shells that hit armour at a shallow angle bounce off instead of penetrating. This makes armour angling a real tactic — presenting your front plate at an oblique angle to the enemy increases effective protection. The King Tiger's sloped armour becomes mechanically meaningful, not just visual.

### Detection

When a shell hits a tank, calculate the **angle of incidence** between the shell's travel direction and the armour face normal:

```
incidenceAngle = angleBetween(shellVelocity, armourFaceNormal)
```

The angle we care about is measured from the armour surface (not the normal). A shell hitting dead-on perpendicular to the plate = 90° from surface = 0° from normal = full penetration. A shell skimming along the plate = close to 0° from surface = close to 90° from normal = ricochet.

**Ricochet threshold: 20° from the armour surface** (i.e., 70° or more from the face normal).

If the angle from the surface is below 20°, the shell ricochets.

### Ricochet probability

Don't make it binary — use a probability curve:

| Angle from surface | Ricochet chance |
|---|---|
| 0–10° | 95% (almost always bounces) |
| 10–15° | 70% |
| 15–20° | 40% |
| 20–25° | 15% |
| 25°+ | 0% (always penetrates) |

This means there's always a small element of luck, which feels right for WW2 tank combat.

### Which armour face?

Use the existing directional damage system. You already determine whether a hit is frontal, side, or rear based on the angle between the shell direction and the tank's facing. Extend this to get the actual face normal:

- **Front face normal**: tank's forward direction
- **Rear face normal**: tank's backward direction (negative forward)
- **Side face normals**: tank's left/right directions

The incidence angle is calculated against whichever face the hit is assigned to.

### Armour slope bonus

Some tanks have inherently sloped armour (T-34, Panther, King Tiger front). Add a `slopeBonus` property to each tank definition — a number of degrees added to the effective armour angle, making ricochets more likely:

| Tank | Slope bonus |
|---|---|
| T-34/76 | +8° (famously well-sloped) |
| Panther | +6° (sloped glacis) |
| King Tiger | +5° (sloped front) |
| JS-II | +6° (curved turret + pike nose) |
| Sherman Firefly | +3° (moderate slope) |
| M26 Pershing | +3° |
| All others | +0° |

This bonus is added to the surface angle before checking the ricochet table. So a 18° hit on a T-34 becomes 26° effective — no ricochet. But a 14° hit on a T-34 becomes 22° effective — still 15% chance to bounce. Without the slope bonus, that 14° hit would have had 70% chance to bounce. The slope bonus actually makes ricochets LESS likely because it raises the effective angle above the ricochet threshold. 

Wait — that's backwards. The slope bonus should make ricochets MORE likely, not less. Let me reconsider.

The slope bonus represents the tank's armour being angled away from incoming fire, which means the shell hits at a shallower angle. So the bonus should be SUBTRACTED from the incidence angle (making it shallower, closer to the surface, increasing ricochet chance):

```
effectiveSurfaceAngle = surfaceAngle - slopeBonus
```

If a shell hits at 22° from the surface on a T-34 (slopeBonus 8°), the effective angle becomes 14° — now in the 70% ricochet zone instead of the 0% zone.

### What happens on ricochet

1. **No damage dealt** to the target tank
2. **Ricochet spark effect**: bright white/yellow spark burst at the hit point, visually distinct from a normal impact spark. Make it brighter, with more horizontal scatter (the sparks fly along the armour surface, not inward)
3. **Ricochet sound**: a sharp metallic "ping" or "clang", distinctly different from the normal impact thud. If the audio system supports it, pitch it higher than a normal hit
4. **Hit indicator text**: show "RICOCHET" in a distinct colour (white or light blue) where you'd normally show the damage number. Show it for both the shooter and the target
5. **The shell is destroyed** — it does not continue on a deflected path. Simulating bounced shell trajectories is complex and not worth the effort
6. **AI awareness**: the AI does not need to know about ricochets. It fires the same as before. Ricochets are a natural mechanical consequence, not something the AI should try to exploit or avoid

### HUD integration

When the player's shot ricochets off an enemy:
- Show "RICOCHET" at the top of the screen in the hit indicator area
- Use a metallic/light colour: `rgba(200, 210, 220, 0.95)`

When an enemy's shot ricochets off the player:
- Show "RICOCHET" similarly
- Do NOT show the red damage vignette (no damage was taken)

### Testing

- Verify at point-blank range head-on (90° from surface): should never ricochet
- Verify at extreme flanking angles: should almost always ricochet
- Verify T-34 gets noticeably more ricochets than Panzer III
- Verify King Tiger front plate bounces shots that would penetrate a Tiger I at the same angle
- Check that HE shells do NOT ricochet — they explode on contact regardless of angle. Only AP shells can ricochet

### Files to modify

- `combat.js` — hit resolution logic, add ricochet check before applying damage
- `tank.js` or `models.js` — add `slopeBonus` to tank definitions
- `particles.js` — add ricochet spark effect (brighter, more horizontal than normal impact)
- `audio.js` — add ricochet ping sound
- HUD rendering code — add RICOCHET indicator

---

## Feature 2: Tank Recovery / Field Repair

### Concept

In Attrition and Strategy modes, destroyed friendly tanks don't always explode into nothing. Some leave recoverable wrecks that another friendly tank can repair back into action. This adds a risk/reward decision: do you push forward or fall back to save a lost squadmate?

### When does a wreck become recoverable?

When a friendly tank is destroyed, check the **overkill amount** — how much damage exceeded its remaining HP:

- If overkill is **less than 30% of the tank's max HP**: the tank becomes a **recoverable wreck**
- If overkill is **30% or more**: the tank is **completely destroyed** (catastrophic kill, ammo cook-off). Normal explosion, no recovery possible

Example: A Sherman Firefly with max HP 94 has 15 HP remaining. It takes a hit dealing 35 damage. Overkill = 35 - 15 = 20. 30% of 94 = 28.2. Overkill (20) < threshold (28.2), so the wreck is recoverable.

A JS-II with 20 HP remaining takes a King Tiger shot dealing 93 damage. Overkill = 73. 30% of max HP ≈ 56. Overkill (73) > threshold (56). Catastrophic kill — no recovery.

### Recoverable wreck visual

- The tank mesh remains in place but is darkened significantly (multiply all vertex colours by 0.3)
- A small amount of grey smoke rises from the wreck (2-3 particles per second, slow rise, fading — much less than the full damaged-tank smoke)
- The wreck does NOT bob or animate — it's static on the terrain
- On the minimap, show recoverable wrecks as a **hollow green circle** (distinguishable from live friendly tanks which are solid green dots)
- A small pulsing icon or text "RECOVERABLE" floats above the wreck, visible within 80 wu

### Recovery mechanic

1. Drive any **friendly** tank within **5 wu** of a recoverable wreck
2. A progress bar appears on the HUD: "RECOVERING... [████░░░░░░] 42%"
3. Recovery takes **12 seconds** of staying within range
4. The recovering tank must be **stationary** (speed < 1 wu/s). If it moves, the progress bar resets
5. The recovering tank CAN rotate its turret and fire while recovering — you're not defenceless
6. If the recovering tank takes damage, recovery is **interrupted** and progress resets to zero
7. On completion: the wreck becomes a live friendly tank again with **25% of max HP**
8. The recovered tank is AI-controlled (wingman). If the player's own tank was the one recovered (in squad modes), they can switch to it with Q/E

### Limits and balance

- A wreck can only be recovered **once**. If the recovered tank is destroyed again, it's gone permanently (no second recovery, regardless of overkill amount)
- Recovery only works on **friendly** tanks, never enemy wrecks
- Wrecks persist for the entire battle. They do not despawn
- Wrecks are solid objects — tanks cannot drive through them (same collision as buildings)
- Enemy AI ignores wrecks. They don't target them or try to prevent recovery
- In Strategy mode, a recovered tank counts as part of your squad. If you win the battle, it carries its HP into the next battle's squad screen

### Modes

- **Attrition**: Yes. This is where it matters most — permanent losses are the core tension
- **Strategy**: Yes. Same mechanics
- **Arcade**: No. Single tank, no squad, no recovery
- **Online**: No (for now). Too complex with networked state

### HUD elements

- When near a recoverable wreck (within 8 wu), show a prompt: "Hold position near wreck to recover (12s)"
- During recovery: progress bar at bottom-centre of screen
- On completion: flash message "TANK RECOVERED — [TankName] at 25% HP"
- On interruption (moved or took damage): flash "RECOVERY INTERRUPTED"

### Audio

- During recovery: a subtle mechanical/repair sound loop (metal clinking, wrench sounds). Can be synthesised as periodic metallic taps
- On completion: a satisfying "clunk" or engine-start sound

### Files to modify

- `combat.js` — on tank death, check overkill threshold, create recoverable wreck if applicable
- `tank.js` — add wreck state, darkened mesh generation, recovery progress tracking
- `game.js` — per-frame check for player proximity to wrecks, recovery progress logic
- `particles.js` — light smoke for wrecks
- `ai.js` — no changes needed (AI ignores wrecks)
- HUD rendering — recovery progress bar, prompts, messages
- Minimap rendering — hollow circle for recoverable wrecks

---

## Feature 3: Dynamic Weather

### Concept

Weather changes during battles, altering visibility, movement, and atmosphere. The flat-shaded aesthetic means weather is communicated through fog, colour palette shifts, and particles rather than texture effects. Each battle gets a weather state that can change once mid-battle.

### Weather types

#### Clear (default, current behaviour)
- No changes from existing visuals
- Full detection ranges for AI
- Normal movement speeds
- This is what every battle is currently

#### Rain
- **Sky**: darken the sky sphere gradient. Shift from blue to grey-blue. Zenith colour from current to `#3a4550`. Horizon from current to `#5a6570`
- **Fog**: tighten fog significantly. `FOG_NEAR` from 300 → 150, `FOG_FAR` from 800 → 400. Fog colour shifts to blue-grey `#5a6570`
- **Terrain colour**: reduce saturation and brightness by ~20%. Greens become muddier, browns become darker
- **Rain particles**: vertical streaks falling from sky. ~200 particles visible at once, each a thin white line (2-pixel-wide, 15-20wu tall), slight diagonal drift. Particles are in screen space or near-camera world space (a volume around the camera, not the whole map). Opacity ~0.15 so they're visible but not obscuring
- **Puddles**: increase the water level by 0.5 wu, flooding low-lying areas slightly more. Or simpler: just darken the ground near water edges
- **Movement**: all tanks move at **85% speed** cross-country (mud). Roads unaffected
- **AI detection range**: reduced by 30%
- **Sound**: optional rain ambient loop (white noise filtered to sound like rain). Low volume, continuous

#### Fog (heavy)
- **Sky**: flatten to near-uniform grey-white `#8a8a85`
- **Fog**: extreme tightening. `FOG_NEAR` 60, `FOG_FAR` 200. Fog colour `#8a8a85`
- **No rain particles** — just thick atmospheric haze
- **Movement**: normal speed
- **AI detection range**: reduced by **60%**. This is the big gameplay effect — fog makes stealth viable. Enemies can't see you until very close
- **AI fire interval**: increased by 50% (they're less certain of targets)
- **Spotter plane**: much more valuable in fog (reveals positions you can't see)

#### Dust Storm
- **Sky**: shift to warm brown-yellow. Zenith `#6a5530`, horizon `#8a7540`
- **Fog**: `FOG_NEAR` 100, `FOG_FAR` 350. Fog colour warm `#8a7540`
- **Dust particles**: similar to rain but horizontal/diagonal, brown-coloured, slightly larger. ~150 particles, each a short streak. Opacity ~0.2, warm brown colour `rgba(140, 115, 60, 0.2)`
- **Movement**: **90% speed** for all tanks (reduced visibility makes drivers cautious — gameplay justification)
- **AI detection range**: reduced by 40%
- **Terrain**: no colour change needed — the fog tint handles it

### Weather assignment

At the start of each battle, roll weather:

| Mode | Weather chances |
|---|---|
| Arcade | 70% Clear, 15% Rain, 10% Fog, 5% Dust |
| Attrition | 50% Clear, 25% Rain, 15% Fog, 10% Dust |
| Strategy | 40% Clear, 25% Rain, 20% Fog, 15% Dust |
| Online | Host selects, or random with same distribution as Strategy |

### Mid-battle weather change

50% chance that weather changes once during a battle:
- Change happens at a random time between 30% and 70% through the battle
- Transition takes **8 seconds**: fog values lerp, sky colours lerp, particle counts ramp up/down
- Any weather can transition to any other weather
- A HUD message announces the change: "Weather changing — rain approaching" / "Fog rolling in" / "Dust storm brewing" / "Weather clearing"

### Implementation approach

Create a `WeatherManager` class/module:

```
WeatherManager {
  currentWeather: 'clear' | 'rain' | 'fog' | 'dust'
  targetWeather: same (during transitions)
  transitionProgress: 0-1
  
  init(mode):  roll initial weather + mid-battle change timing
  update(dt):  lerp fog/sky/speed if transitioning; manage particles
  
  getFogNear(): returns current (possibly lerped) fog near
  getFogFar(): returns current fog far
  getFogColor(): returns current fog colour
  getSkyColors(): returns zenith + horizon colours
  getSpeedMultiplier(): returns 0.85-1.0
  getDetectionMultiplier(): returns 0.4-1.0
  getFireIntervalMultiplier(): returns 1.0-1.5
}
```

Each frame during gameplay, the renderer reads from `WeatherManager` to set fog and sky. The AI reads detection and fire interval multipliers. Tank movement reads speed multiplier.

### Rain/dust particles

Use a particle pool attached to the camera (not world-space). Create a volume roughly 80×60×80 wu centred on the camera. Particles spawn at the top, fall (rain) or drift (dust), and recycle when they leave the volume. This keeps particle count constant regardless of map size.

For rain:
- Particle: thin vertical line, white, opacity 0.15
- Fall speed: 80 wu/s + slight horizontal drift (5 wu/s in a consistent wind direction)
- Pool: ~200 particles

For dust:
- Particle: short horizontal streak, brown, opacity 0.2
- Drift speed: 25 wu/s horizontal, 3 wu/s downward
- Pool: ~150 particles

### Settings integration

Add a "Weather" option to the Settings panel:
- **Auto** (default): random weather as described above
- **Clear**: forces clear weather every battle
- **Rain / Fog / Dust**: forces that weather every battle (useful for testing or preference)

### Display on battle start

When a battle starts, briefly show the weather condition: "Clear skies" / "Rainy conditions — reduced visibility" / "Dense fog — extreme close quarters" / "Dust storm — limited visibility"

### Files to modify/create

- **New**: `weather.js` — WeatherManager class
- `game.js` — init weather on battle start, call weather.update() each frame
- `terrain.js` or renderer setup — read fog values from WeatherManager instead of constants
- `ai.js` — multiply detection range and fire interval by weather factors
- `tank.js` — multiply movement speed by weather factor
- `particles.js` — add rain and dust particle systems
- `config.js` — add weather settings, weather parameter tables
- Settings panel — add Weather dropdown
- HUD — weather change announcement, battle-start weather display

---

## Feature 4: Capture the Flag (Online Mode)

### Concept

A new game type for Online mode. Each team has a flag at their base. Steal the enemy's flag and bring it back to your own base to score. First team to 3 captures wins. Tanks carrying the flag can't fire and move at reduced speed — they need teammates to escort them.

### Setup

- Available as a game type option when hosting an Online room (alongside the existing deathmatch/team modes)
- Requires exactly **2 teams** (not 3 or 4). Host selects CTF mode; only 2 team slots are available
- Minimum 2 players (1v1) up to 8v8
- Each team gets a **flag base** positioned at opposite ends of the map
- Flag base position: calculated from team spawn areas. If teams spawn at roughly +X and -X sides of the map, flags are placed at those spawn centres

### Flag object

- Visual: a tall pole (thin cylinder, 8wu tall) with a coloured rectangular flag at the top (team colour). The flag should wave gently (vertex animation, simple sine offset on the outer edge vertices). Base is a small circular platform (2wu radius)
- Minimap: flag shown as a **star icon** in the team's colour at its current position (either at base or moving with the carrier)
- The flag is always visible on the minimap to both teams — no fog-of-war on flags
- When at its base: the flag sits on the pole, fully visible
- When carried: the flag appears above the carrying tank (floating 3wu above the turret), the pole at the base disappears

### Flag capture mechanics

1. **Picking up the enemy flag**: Drive within **5 wu** of the enemy flag base while the flag is there. Automatic — no key press needed. The flag attaches to your tank
2. **Scoring**: Drive the enemy flag back to **your own flag base** (within 5 wu) while **your own flag is also at your base** (not stolen). This scores 1 point for your team
3. **Dropping the flag**: If the flag carrier is destroyed, the flag drops at that position on the ground. It sits there for **30 seconds**. During that time:
   - Any teammate of the carrier can pick it up by driving within 5wu (continues the capture attempt)
   - Any player on the flag's own team can **return** it by driving within 5wu (flag instantly teleports back to its base)
   - If nobody touches it in 30 seconds, it auto-returns to its base
4. **Flag defence**: You cannot pick up your OWN flag (it's already yours). You can only return it if it's been dropped by a killed enemy carrier

### Carrier restrictions

The tank carrying the flag suffers penalties:
- **Cannot fire** — main gun disabled. This is the core balance mechanic. The carrier is defenceless and needs escort
- **75% movement speed** — weighed down
- **Visible to all**: the carrier always appears on the minimap for both teams, regardless of fog-of-war or spotter status. A bright pulsing dot
- **Cannot use abilities**: no smoke, no artillery, no spotter while carrying

### Scoring and win condition

- Each successful capture scores **1 point** for the team
- First team to **3 points** wins
- On capture: big announcement for all players — "BLUE TEAM CAPTURED THE FLAG! Score: 2-1"
- If no team reaches 3 after **10 minutes**, the team with more captures wins. If tied, sudden death — next capture wins

### HUD elements

- **Score display**: top-centre, both team scores: "GOLD 1 — 2 BLUE"
- **Flag status indicators**: below the score, show the state of each flag:
  - "YOUR FLAG: At Base" / "YOUR FLAG: STOLEN by [PlayerName]!" / "YOUR FLAG: Dropped (18s)"
  - "ENEMY FLAG: At Base" / "ENEMY FLAG: Carried by [PlayerName]" / "ENEMY FLAG: Dropped (12s)"
- When you're carrying the flag: prominent "YOU HAVE THE FLAG — Return to base! 🏁" at the centre of the screen, persistent
- "NO FIRE" indicator replaces the ammo type display when carrying
- Timer: show match time remaining (counts down from 10:00)

### Respawning

Unlike standard Online mode (instant death = defeat), CTF needs respawning:
- On death: **8 second** respawn timer, shown as a countdown overlay
- Respawn at your team's flag base
- Respawn with full HP in the same tank you selected at the start
- No limit on respawns

### Minimap additions

- Flag bases: large star icons in team colour (persistent, always shown)
- Flags: star icon at current position (at base, with carrier, or dropped on ground)
- Dropped flag: star icon pulses/flashes with a countdown ring shrinking around it
- Flag carrier: their dot on the minimap is **larger** and has the star icon overlaid

### Audio

- **Flag picked up** (you): triumphant brass sting or horn blast
- **Flag picked up** (enemy): alarm klaxon or warning tone
- **Flag captured** (score): big celebratory sound (your team) or defeat sting (enemy team)
- **Flag dropped**: thud/clatter
- **Flag returned**: positive chime (your flag returned to base)
- **30-second warning** (match timer): ticking sound

### Network protocol additions

New message types for the relay:

```javascript
// Server → All clients
{ type: "ctf_flagPickup", team: 0, playerId: "abc", playerName: "Player1" }
{ type: "ctf_flagDrop", team: 0, position: {x, y, z}, dropTime: timestamp }
{ type: "ctf_flagReturn", team: 0 }  // flag returned to base (by touch or timeout)
{ type: "ctf_flagCapture", team: 1, playerId: "abc", score: [1, 2] }  // team 1 scored, new scores
{ type: "ctf_gameOver", winningTeam: 1, finalScore: [1, 3] }

// State broadcast includes:
// - flag positions (2 flags)
// - flag states: 'base' | 'carried' | 'dropped'  
// - carrier player IDs (if carried)
// - drop timers (if dropped)
// - team scores
```

The host is authoritative on all flag state. Clients render flag position from state broadcasts. Pickup/drop/return/capture events are determined by the host and broadcast as events.

### Implementation order

1. **Flag object**: visual (pole + flag mesh + waving animation), placed at team spawns
2. **Pickup/drop/return logic**: proximity checks on the host, state machine for each flag
3. **Carrier restrictions**: disable fire, reduce speed, force minimap visibility
4. **Scoring**: capture detection, score tracking, win condition
5. **Respawn system**: death timer, respawn at base
6. **HUD**: score display, flag status, carrier indicator, timer
7. **Minimap**: flag icons, carrier highlighting, drop timer visualisation
8. **Network messages**: new event types, flag state in broadcasts
9. **Audio**: pickup/drop/capture/return sounds
10. **Lobby UI**: CTF mode option when hosting, team restriction to 2 teams

### Files to modify/create

- **New**: `ctf.js` — CTFManager class: flag state machine, scoring, win condition, carrier tracking
- `net.js` — new message types for flag events, flag state in broadcasts
- `game.js` — integrate CTF logic into game loop, respawn system
- `combat.js` — check carrier status before allowing fire
- `tank.js` — speed penalty for carrier
- `models.js` or new file — flag pole + flag mesh + waving animation
- HUD rendering — score, flag status, carrier prompt, respawn timer
- Minimap rendering — flag icons, carrier highlighting
- `audio.js` — new sounds for flag events
- Online lobby UI — CTF mode option, 2-team restriction
