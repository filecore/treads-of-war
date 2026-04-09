#!/usr/bin/env node
// relay-server.js — WebSocket game relay for Treads of War LAN play (N-player)
//
// Run as a persistent Docker service on the LAN games server.
// Players connect to ws://[server]:8765; all game traffic is relayed.
// No WebRTC, no local installation required on player machines.
//
// npm install ws

const http = require('http');
const { WebSocketServer } = require('ws');

const port = parseInt(process.argv[2] || '8765', 10);

// Map<code, { hostWs: ws|null, clients: Map<id, ws>, maxPlayers: number, nextId: number }>
const rooms = {};

function getRoom(code) {
  if (!rooms[code]) rooms[code] = { hostWs: null, clients: new Map(), maxPlayers: 2, nextId: 1 };
  return rooms[code];
}

function pruneRoom(code) {
  const r = rooms[code];
  if (r && !r.hostWs && r.clients.size === 0) delete rooms[code];
}

function isAlive(ws) {
  return ws && ws.readyState === 1 /* OPEN */ && ws._alive !== false;
}

function evict(ws) {
  if (!ws) return;
  try { ws.send(JSON.stringify({ type: 'error', msg: 'Evicted: new player claimed your slot' })); } catch { /**/ }
  try { ws.terminate(); } catch { /**/ }
}

function sendTo(ws, obj) {
  if (ws && ws.readyState === 1) try { ws.send(JSON.stringify(obj)); } catch { /**/ }
}

// Broadcast to all clients in room
function broadcastToClients(room, obj) {
  const raw = JSON.stringify(obj);
  for (const [, ws] of room.clients) {
    if (ws.readyState === 1) try { ws.send(raw); } catch { /**/ }
  }
}

// Broadcast to all in room (host + clients), except optional excludeId
function broadcastToAll(room, obj, excludeId = null) {
  if (room.hostWs && isAlive(room.hostWs) && excludeId !== 'h') sendTo(room.hostWs, obj);
  for (const [id, ws] of room.clients) {
    if (id !== excludeId && ws.readyState === 1) try { ws.send(JSON.stringify(obj)); } catch { /**/ }
  }
}

// ── HTTP (discovery + health) ─────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/discover') {
    const waiting = Object.entries(rooms)
      .filter(([, r]) => r.hostWs && isAlive(r.hostWs))
      .map(([code, r]) => ({
        code,
        players: r.clients.size + 1,
        max: r.maxPlayers,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'Treads of War Relay', rooms: waiting }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(404); res.end();
});

// ── WebSocket relay ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// ── Heartbeat — ping every 30s, kill connections that don't respond ───────────
const HEARTBEAT_MS = 30_000;
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws._alive === false) {
      console.log('[relay] Terminating unresponsive connection');
      ws.terminate();
      return;
    }
    ws._alive = false;
    try { ws.ping(); } catch { /**/ }
  });
}, HEARTBEAT_MS);

wss.on('connection', ws => {
  ws._room  = null;
  ws._id    = null;
  ws._alive = true;

  ws.on('pong', () => { ws._alive = true; });

  ws.on('message', raw => {
    ws._alive = true;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Role registration ──────────────────────────────────────────────────────
    if (msg.type === 'role') {
      const code = (msg.room || '').toUpperCase().trim();
      if (!code) { sendTo(ws, { type: 'error', msg: 'No room code' }); return; }

      const room = getRoom(code);

      if (msg.role === 'host') {
        if (room.hostWs && room.hostWs !== ws) {
          if (isAlive(room.hostWs)) {
            sendTo(ws, { type: 'error', msg: 'Room already has a host' });
            return;
          }
          console.log(`[relay] Evicting stale host  room=${code}`);
          evict(room.hostWs);
          room.hostWs = null;
        }
        room.hostWs    = ws;
        room.maxPlayers = Math.max(2, Math.min(16, parseInt(msg.maxPlayers) || 2));
        ws._room = code;
        ws._id   = 'h';
        console.log(`[relay] Host joined   room=${code}  max=${room.maxPlayers}`);
        sendTo(ws, { type: 'joined', id: 'h', role: 'host' });

      } else if (msg.role === 'client') {
        if (!room.hostWs || !isAlive(room.hostWs)) {
          if (room.hostWs) { evict(room.hostWs); room.hostWs = null; }
          sendTo(ws, { type: 'error', msg: 'No host in that room' });
          return;
        }
        const total = room.clients.size + 1; // +1 for host
        if (total >= room.maxPlayers) {
          sendTo(ws, { type: 'error', msg: 'Room is full' });
          return;
        }
        // Assign new client ID
        const id = `p${room.nextId++}`;
        room.clients.set(id, ws);
        ws._room = code;
        ws._id   = id;
        console.log(`[relay] Client joined room=${code}  id=${id}  total=${room.clients.size + 1}`);

        // Tell the new joiner their ID + list of existing peers
        const existingPeers = ['h', ...room.clients.keys()].filter(k => k !== id);
        sendTo(ws, { type: 'joined', id, role: 'client', peers: existingPeers });

        // Tell everyone else someone new joined
        broadcastToAll(room, { type: 'peer_joined', id }, id);
      }
      return;
    }

    // ── Game data routing ──────────────────────────────────────────────────────
    if (!ws._room || !rooms[ws._room]) return;
    const room = rooms[ws._room];

    if (ws._id === 'h') {
      // Host → broadcast to all clients (inject from='h')
      let obj;
      try { obj = JSON.parse(raw); } catch { return; }
      obj.from = 'h';
      const out = JSON.stringify(obj);
      for (const [, cws] of room.clients) {
        if (cws.readyState === 1) try { cws.send(out); } catch { /**/ }
      }
    } else if (ws._id) {
      // Client → forward to host only (inject from=id)
      if (!room.hostWs || room.hostWs.readyState !== 1) return;
      let obj;
      try { obj = JSON.parse(raw); } catch { return; }
      obj.from = ws._id;
      try { room.hostWs.send(JSON.stringify(obj)); } catch { /**/ }
    }
  });

  ws.on('close', () => {
    const code = ws._room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (ws._id === 'h') {
      console.log(`[relay] Host left     room=${code}`);
      room.hostWs = null;
      broadcastToClients(room, { type: 'host_gone' });
    } else if (ws._id) {
      console.log(`[relay] Client left   room=${code}  id=${ws._id}`);
      room.clients.delete(ws._id);
      broadcastToAll(room, { type: 'peer_left', id: ws._id });
    }
    pruneRoom(code);
  });
});

httpServer.listen(port, () => {
  console.log(`[relay] Treads of War relay server listening on port ${port}`);
});
