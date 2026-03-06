#!/usr/bin/env node
// signalling-server.js — WebRTC signalling relay for Conqueror LAN play
//
// Run:   node signalling-server.js [port]   (default port: 8765)
//
// Supports multiple concurrent games via room codes. Each hosted game gets a
// 4-character alphanumeric code. Clients join by supplying the same code.
//
// Prerequisites:  npm install ws   (or: npm init -y && npm install ws)

const http = require('http');
const { WebSocketServer } = require('ws');

const port = parseInt(process.argv[2] || '8765', 10);

// rooms: Map<code, { host: WebSocket|null, client: WebSocket|null }>
const rooms = {};

function getRoom(code) {
  if (!rooms[code]) rooms[code] = { host: null, client: null };
  return rooms[code];
}

function pruneRoom(code) {
  const r = rooms[code];
  if (r && !r.host && !r.client) delete rooms[code];
}

// ── HTTP server (discovery endpoint) ─────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  if (req.method === 'GET' && req.url === '/discover') {
    // Return all rooms that have a host waiting but no client yet
    const waiting = Object.entries(rooms)
      .filter(([, r]) => r.host && !r.client)
      .map(([code]) => ({ code }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'Conqueror LAN Server', rooms: waiting }));
    return;
  }

  res.writeHead(404); res.end();
});

// ── WebSocket server (signalling) ─────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', ws => {
  console.log('[sig] Peer connected');
  ws._room = null;   // room code this peer belongs to
  ws._role = null;   // 'host' | 'client'

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'role') {
      const code = (msg.room || '').toUpperCase().trim();
      if (!code) { ws.send(JSON.stringify({ type: 'error', msg: 'No room code' })); return; }

      ws._room = code;
      ws._role = msg.role;
      const room = getRoom(code);

      if (msg.role === 'host') {
        if (room.host && room.host !== ws) {
          // Slot taken — reject
          ws.send(JSON.stringify({ type: 'error', msg: 'Room already has a host' }));
          ws._room = null; return;
        }
        room.host = ws;
        console.log(`[sig] Host registered  room=${code}`);
        if (room.client) {
          room.host.send(JSON.stringify({ type: 'ready' }));
          room.client.send(JSON.stringify({ type: 'ready' }));
        }

      } else if (msg.role === 'client') {
        if (!room.host) {
          ws.send(JSON.stringify({ type: 'error', msg: 'No host in that room' }));
          ws._room = null; return;
        }
        if (room.client && room.client !== ws) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Room is full' }));
          ws._room = null; return;
        }
        room.client = ws;
        console.log(`[sig] Client registered room=${code}`);
        room.host.send(JSON.stringify({ type: 'ready' }));
        room.client.send(JSON.stringify({ type: 'ready' }));
      }

    } else {
      // Relay offer / answer / ICE verbatim to the other peer in the same room
      if (!ws._room) return;
      const room = rooms[ws._room];
      if (!room) return;
      const target = ws === room.host ? room.client : room.host;
      if (target && target.readyState === 1 /* OPEN */) target.send(raw);
    }
  });

  ws.on('close', () => {
    const code = ws._room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (ws === room.host) {
      console.log(`[sig] Host disconnected  room=${code}`);
      room.host = null;
      if (room.client) room.client.send(JSON.stringify({ type: 'peer_gone' }));
    } else if (ws === room.client) {
      console.log(`[sig] Client disconnected room=${code}`);
      room.client = null;
      if (room.host) room.host.send(JSON.stringify({ type: 'peer_gone' }));
    }
    pruneRoom(code);
    if (!rooms[code]) console.log(`[sig] Room ${code} closed`);
  });
});

httpServer.listen(port, () => {
  console.log(`[sig] Conqueror signalling server on port ${port}`);
  console.log(`[sig]   WebSocket:  ws://0.0.0.0:${port}`);
  console.log(`[sig]   Discovery:  http://0.0.0.0:${port}/discover`);
  console.log('[sig] Supports multiple concurrent games via room codes.');
});
