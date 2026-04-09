# Treads of War

A browser-based 3D tank combat game built with Three.js. Inspired by Conqueror (Superior Software, 1988, Acorn Archimedes). Flat-shaded polygon aesthetic, WWII European theatre, procedurally generated terrain. Four game modes, 16 tanks across 4 factions, online play for up to 16 players.

**Runs entirely in your browser - no download required.**

---

## Inspiration

Conqueror (1988) by Superior Software was one of the definitive tank combat games for the Acorn Archimedes - flat-shaded rolling hills, a roster of WWII vehicles with genuine stat differences, and satisfying armour-penetrating physics. Treads of War is a browser reimplementation of that experience, built from scratch with Three.js. 

---

## AI disclosure

This has been a long-runing passion project that I was just working on locally. Recently, I was able to utilise Claude Code to help with improvements and feature development. This sped things up VASTLY, really as a hobbyist I was shocked how much progress I made. That's why I decdided to put in on Github (old habits from my childhood are just to develop locally for my own sake). I'm sure everybody is sick of vibe-coded slop, and I'm sure by now large chunks of the codebase fit this category. Is that important? This is a game. It doesn't require or store any sensitive information. If Claude can help me get it out faster and with more and better features, then that's fine by me. I'm learning a lot fna having fun, and that's really my aim here. If you don't like AI assistance in projects, feel free to move along. 

---

## Game modes

**Arcade** - Solo survival. Survive endless waves of enemy armour. Every 4 kills upgrades your tank class (light to medium to medium-heavy to heavy). Three lives. Waves grow larger at the heavy class tier.

**Attrition** - Fixed squad of 5 allied tanks, permanent losses. Enemy squads escalate each battle through 4 tiers. Switch between surviving tanks with Q/E. Smoke grenades and HE ammo available.

**Strategy** - Budget purchase screen before each battle. Buy any mix of tanks from your faction within the budget. Win by holding the objective ring for 60 continuous seconds. All abilities available: smoke, artillery barrage, spotter plane. Supply crates spawn on the map.

**Online** - Up to 16 players (8v8) over LAN or the internet via WebSocket relay. Host runs authoritative simulation at 60 fps, broadcasts at 20 Hz. Client-side prediction with server correction. 4 team colours, room codes, ping display, CTF mode available.

---

## Features

- Procedural Fourier terrain - six overlapping sine waves, unique every battle
- Chunk-streamed world: 11x11 grid of chunks loaded around the player
- Roads, rivers, ponds, destructible trees, farmhouse buildings
- Persistent track marks and shell craters per battle
- Dynamic weather: clear, rain, fog, dust storm - transitions mid-battle
- AP and HE ammo; ballistic shell arcs with gravity
- Directional armour (front/side/rear) with ricochet probability by angle
- Damage states: half speed to quarter speed to immobilised to catastrophic
- Wreck recovery: low-overkill kills leave recoverable wrecks (Attrition/Strategy)
- Aim assist, gun-sight mode (V key, 14 degree FOV), mouse aim option
- Minimap with roads, water, objective, enemy positions (spotter-gated in Strategy)
- Obliterator IV editor: fully customisable stat and visual editor for the Mercenary faction
- Works on desktop and modern mobile browsers (mobile: beta)

---

## Tank roster

16 tanks across 4 historically-inspired factions (well, 3 historically-inspired and one totally inaccurate).

| Faction | Tanks |
|---|---|
| Allied | M24 Chaffee, M36 90mmGMC, Sherman Firefly, M26 Pershing |
| Axis | Panzer III, Panther, Tiger I, King Tiger |
| Soviet | T-34/76, KV-1S, KV-85, JS-II |
| Mercenary (experimental) | Marauder Mk II, Interceptor, Vulture Type I, Obliterator IV |

---

## Controls

| Key | Action |
|---|---|
| W / S | Accelerate / reverse |
| A / D | Turn left / right |
| Q / E | Traverse turret left / right (also: switch tank in squad modes) |
| Space | Fire |
| Tab | Switch ammo AP/HE (Arcade) or switch controlled tank (Attrition/Strategy) |
| V | Gun-sight mode (hold) |
| G | Smoke screen (Attrition/Strategy) |
| C | Artillery barrage (Strategy) |
| X | Spotter plane (Strategy) |
| P | Pause |
| R | Next wave / continue |

---

## Running locally

Any static file server works:

```bash
./serve.sh          # Python 3, serves on http://localhost:8080
# or
docker compose up   # nginx on port 53312
```

Online mode requires the relay server:

```bash
cd relay && npm install && node relay-server.js
# Listens on port 8765 - players must be able to reach it on your LAN
```

---

## Server setup (Docker + nginx)

### Docker Compose

```yaml
services:
  treads:
    image: nginx:alpine
    ports:
      - "53312:80"
    volumes:
      - ./src:/usr/share/nginx/html:ro
    restart: unless-stopped

  relay:
    build: ./relay
    ports:
      - "8765:8765"
    restart: unless-stopped
```

### Nginx - proxy `/relay` to the relay container

```nginx
location = /relay {
    proxy_pass         http://relay:8765;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade    $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host       $host;
    proxy_read_timeout 86400s;
}

location = /relay/discover {
    proxy_pass       http://relay:8765/discover;
    proxy_set_header Host $host;
}
```

Verify: `curl http://localhost:<port>/relay/discover` should return `{"name":"Treads of War Relay","rooms":[]}`.

If serving over HTTPS via a reverse proxy (e.g. Traefik, Caddy, NPM), enable **Websockets Support** on the proxy host. The game auto-switches between `ws://` (HTTP) and `wss://` (HTTPS).

### Deploy script

```bash
./deploy.sh
```

Rsyncs `src/` and `relay/` to the remote server, then SSHs in to rebuild and restart the relay container. Edit `TREADS_REMOTE` at the top of the script for your server path.

---

## Tech stack

- **Renderer**: Three.js (WebGL), no build step, vanilla ES modules
- **Audio**: Web Audio API (no audio files - all synthesised)
- **Networking**: WebSocket relay (Node.js) for Online mode
- **Deployment**: nginx static serving + Docker Compose

---

## Source layout

```
src/            Game source (HTML, CSS, JS modules)
src/js/         Game modules: main.js, config.js, tank.js, ai.js, combat.js,
                terrain.js, weather.js, particles.js, models.js, audio.js,
                input.js, game.js, modes.js, net.js, ctf.js
relay/          WebSocket relay server (Node.js)
analysis/       Binary analysis notes and tools
deploy.sh       rsync + relay rebuild in one step
serve.sh        Local dev server (Python http.server)
docker-compose.yml
nginx-sample.conf
```

---

## Legal

Fan project. Unofficial and non-commercial. No original assets from Conqueror (1988) are included. Contact: [email protected]
