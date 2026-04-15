# Treaducation — Code & Learn

A five-step tutorial that takes you from a blank HTML file to a working
two-player 3D tank game, built entirely in the browser using Three.js.

No install required. No terminal. No prior experience needed.
Just a text editor and Chrome or Firefox.

---

## How it works

Each step is a single HTML file. Open it in your browser and you'll see
the finished result. Your job is to recreate it yourself from scratch —
not to copy the file, but to read the code, understand what it does,
and write your own version.

Use these files to check your work, look up syntax, or get unstuck.
The README hints below tell you what to build without giving it away.

---

## The five steps

### Step 1 — Hello World (`step1-hello-world.html`)

**Goal:** Get Three.js running and see something on screen.

Your job:
- Create an HTML file with a `<script type="importmap">` block that points
  at Three.js on unpkg.com (version 0.158.0)
- Write a `<script type="module">` that creates a Scene, a Camera, and a Renderer
- Add a BoxGeometry cube to the scene with a green MeshBasicMaterial
- Write an `animate()` function that rotates the cube and calls `renderer.render()`
- Call `requestAnimationFrame(animate)` inside `animate` to loop it

Hint: the Camera needs `camera.position.z = 5` so it's not inside the cube.
The Renderer needs `document.body.appendChild(renderer.domElement)` to appear on screen.

---

### Step 2 — Flat Terrain (`step2-terrain.html`)

**Goal:** Replace the cube with an open world you can look around.

Your job:
- Remove the cube
- Add a large PlaneGeometry (try 1000 x 1000) — remember to rotate it flat with
  `terrainGeo.rotateX(-Math.PI / 2)`
- Add a GridHelper on top of it (raise it slightly with `grid.position.y = 0.01`)
- Set `scene.background` to a sky blue colour
- Add `scene.fog = new THREE.Fog(skyColour, 100, 450)` to hide the horizon
- Import OrbitControls from `three/addons/controls/OrbitControls.js` and
  add them so you can click-drag to look around

Hint: if the fog colour and the background colour don't match, the horizon
will have a visible seam. Use the same hex value for both.

---

### Step 3 — Tank & Controls (`step3-tank.html`)

**Goal:** Build a tank from boxes and drive it around.

Your job:
- Remove OrbitControls
- Write a `createTank(bodyColour, turretColour)` function that returns a THREE.Group
  containing three boxes: hull, turret box, and barrel
  (the barrel should be positioned at `z = -1.2` inside its own sub-group, the turretGroup)
- Add keyboard input: listen for `keydown` and `keyup`, storing state in a `keys = {}` object
- In your animate loop, use `tank.translateZ(-speed * dt)` for W/S
  and `tank.rotation.y += turnSpeed * dt` for A/D
- Get delta time with `const clock = new THREE.Clock()` and `clock.getDelta()` each frame
- Move the camera behind the tank each frame using `camOffset.applyEuler(tank.rotation)`

Hint: `translateZ` moves along the object's OWN local axis, so it always goes
"forward" relative to where the tank is pointing. That's what makes it useful here.

---

### Step 4 — Shooting (`step4-shoot.html`)

**Goal:** Aim the turret, fire shells, and hit a target.

Your job:
- Add Q/E to rotate `tank.turretGroup.rotation.y`
- Fire a shell on Space: create a SphereGeometry, set its position using
  `tank.turretGroup.localToWorld(new THREE.Vector3(0, 0.05, -2.0))`,
  and set `mesh.rotation.y = tank.rotation.y + tank.turretGroup.rotation.y`
- Keep an array of active shells; move each one with `translateZ(-speed * dt)` each frame
- Add a red BoxGeometry target somewhere on the terrain
- Use `new THREE.Box3().setFromObject(target)` and `box.containsPoint(shell.position)`
  to detect hits
- On hit: flash the target, increment a score counter in the DOM, respawn the target
- When a shell expires or hits, call `scene.remove(mesh)` and `mesh.geometry.dispose()`

Hint: iterate the shells array BACKWARDS when removing items, like
`for (let i = shells.length - 1; i >= 0; i--)`. Removing from a forwards
loop skips the item after the removed one.

---

### Step 5 — 1v1 (`step5-1v1.html`)

**Goal:** Two players. Five hits wins. Real game.

Your job:
- Call `createTank()` twice with different colours (e.g. blue and red)
- Define a player object for each: `{ tank, hp, maxHp, barEl, keys: { forward, backward, ... } }`
- Write a single `updatePlayer(player, dt)` function that reads from `player.keys`
  and moves `player.tank` — then call it for both players each frame
- Each shell needs an `owner` or `target` property so it only checks collision
  against the opposing tank
- Add two `<div>` health bars to the HTML; update their `style.width` on hit
- Add a `gameOver` flag; when hp reaches 0, show a win banner
  and stop updating tanks until R is pressed
- Write a `resetGame()` function that sets both tanks back to their start positions
  and resets all state
- Replace the single-tank follow camera with one that watches the midpoint
  between both tanks and pulls back based on their separation distance

Hint: the camera midpoint is
`new THREE.Vector3().addVectors(p1.tank.position, p2.tank.position).multiplyScalar(0.5)`

---

## What's next?

Once you've finished Step 5, here are ideas to keep going:

- Add terrain height variation (look at `SimplexNoise` or the `getAltitude` function in Treads)
- Add a third player (can you adapt `updatePlayer` to handle three?)
- Replace the boxes with a more detailed tank model
- Add a reload timer so you can't fire continuously
- Add a boundary so tanks can't drive off the edge

The full Treads of War source code is available at `treads.example.com/treads/`
if you want to see where all these ideas eventually lead.

---

## Files in this download

| File | Description |
|------|-------------|
| `step1-hello-world.html` | Finished reference: rotating cube |
| `step2-terrain.html` | Finished reference: flat terrain with OrbitControls |
| `step3-tank.html` | Finished reference: driveable tank |
| `step4-shoot.html` | Finished reference: turret + shooting + target |
| `step5-1v1.html` | Finished reference: complete 1v1 game |
| `README.md` | This file |

All files work when opened directly from your desktop (`file://` URL).
No server needed.

---

Free to use for any educational purpose.
