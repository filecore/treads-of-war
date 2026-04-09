# Treads of War — Source

A browser-based 3D tank combat game inspired by Conqueror (Superior Software, 1988, Acorn Archimedes). Built with Three.js, it grew far beyond the original's scope with new modes, online play, and enhanced terrain. Non-commercial fan project. Feel free to reach out: jason.togneri@gmail.com. Thanks! March 2026.

**Play it live:** https://treads.togneri.net

---

## What's in this archive

```
src/            Game source (HTML, CSS, JS) — serve as static files
relay/          WebSocket relay server (Node.js) — required for LAN Duel mode
deploy.sh       One-step build + rsync to remote games server
serve.sh        Local dev server (Python http.server)
docker-compose.yml   Sample compose config for local/LAN hosting
nginx-sample.conf    Sample nginx location blocks for /relay proxy
README.md       This file
```

---

## Quick start (local / LAN play)

1. **Serve the game** — any static file server works:
   ```bash
   ./serve.sh          # Python 3, serves on http://localhost:8080
   # or
   docker compose up   # nginx on port 53312 (see docker-compose.yml)
   ```

2. **Run the relay** (needed only for LAN Duel mode):
   ```bash
   cd relay && npm install && node relay-server.js
   ```
   The relay listens on port `8765`. Players must be able to reach it on your LAN.

3. Open the game in a browser, go to **Settings → Enable LAN Duel**, select **LAN Duel** from the mode list, and click **Host Game**.

---

## Server setup (Docker Compose + nginx)

This is the same guide shown in the **Server Setup** tab inside the game.

### 1 · Docker Compose

Add the relay service alongside your games nginx container:

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

Start everything:
```bash
docker compose up -d --build relay
```

### 2 · Nginx config

The games nginx config must proxy `/relay` to the relay container. Add these two location blocks:

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

Use the Docker service name `relay` (not an IP). Reload nginx after editing:
```bash
docker compose exec <nginx-service-name> nginx -s reload
```

Verify: `curl http://localhost:<port>/relay/discover` should return `{"name":"Treads of War Relay","rooms":[]}`.

### 3 · Reverse proxy (NPM — for HTTPS / internet play)

In Nginx Proxy Manager, edit the proxy host for your games domain:
- **Details** tab → enable **Websockets Support**
- Save. No custom location blocks needed in NPM — the inner nginx handles `/relay` routing.

Without this toggle, NPM strips the `Upgrade` header and the WebSocket handshake fails silently.

### 4 · Firewall

- **LAN play (HTTP)**: port `8765` must be open on your host firewall (`ufw allow 8765/tcp`).
- **Internet play (HTTPS)**: port `8765` does not need to be internet-facing — all traffic enters via port `443` through NPM.

### 5 · Deploy script

`deploy.sh` handles everything in one step: rsyncs `src/` and `relay/` to the remote, then SSHs in to rebuild and restart the relay container:

```bash
./deploy.sh
```

Edit the `TREADS_REMOTE` variable at the top of `deploy.sh` to point at your server path.

---

## LAN vs HTTPS connection modes

| Mode | URL scheme | Port | Relay path |
|------|-----------|------|------------|
| Local dev | `ws://localhost:8765` | 8765 direct | — |
| LAN (HTTP) | `ws://<server-ip>:8765` | 8765 direct | — |
| Internet (HTTPS) | `wss://<domain>/relay` | 443 via NPM | `/relay` proxy |

The game auto-detects which mode to use based on whether the page is served over HTTP or HTTPS.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 404 on `/relay/discover` | nginx proxy locations missing or nginx not reloaded |
| WebSocket connection refused | relay container not running, or NPM WebSocket Support off |
| LAN works, internet doesn't | NPM WebSocket Support toggle is off |
| Internet works, LAN doesn't | port 8765 blocked by host firewall |
| Find Games shows nothing | host hasn't clicked Host Game yet, or relay restarted |

---

For a visual walkthrough, open the game and go to **Settings → Server Setup**.
