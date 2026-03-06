#!/usr/bin/env node
// relay-server.js — WebSocket game relay for Conqueror LAN play
//
// Run as a persistent Docker service on the LAN games server.
// Both players connect to ws://[server]:8765; all game traffic (state
// snapshots, inputs, events) is relayed through this server.
// No WebRTC, no local installation required on player machines.
//
// npm install ws

const http = require('http');
const { WebSocketServer } = require('ws');

const port = parseInt(process.argv[2] || '8765', 10);
const rooms = {};   // Map<code, { host: ws|null, client: ws|null }>

function getRoom(code) {
  if (!rooms[code]) rooms[code] = { host: null, client: null };
  return rooms[code];
}

function pruneRoom(code) {
  const r = rooms[code];
  if (r && !r.host && !r.client) delete rooms[code];
}

// ── HTTP (discovery + health) ─────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/discover') {
    const waiting = Object.entries(rooms)
      .filter(([, r]) => r.host && !r.client)
      .map(([code]) => ({ code }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'Conqueror Relay', rooms: waiting }));
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

wss.on('connection', ws => {
  ws._room = null;
  ws._role = null;

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
          ws.send(JSON.stringify({ type: 'error', msg: 'Room already has a host' }));
          ws._room = null; return;
        }
        room.host = ws;
        console.log(`[relay] Host joined   room=${code}`);
        if (room.client) {
          room.host.send(JSON.stringify({ type: 'connected' }));
          room.client.send(JSON.stringify({ type: 'connected' }));
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
        console.log(`[relay] Client joined room=${code}`);
        room.host.send(JSON.stringify({ type: 'connected' }));
        room.client.send(JSON.stringify({ type: 'connected' }));
      }
      return;
    }

    // Relay any game message to the peer in the same room
    if (!ws._room || !rooms[ws._room]) return;
    const room = rooms[ws._room];
    const target = ws === room.host ? room.client : room.host;
    if (target && target.readyState === 1 /* OPEN */) target.send(raw);
  });

  ws.on('close', () => {
    const code = ws._room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (ws === room.host) {
      console.log(`[relay] Host left     room=${code}`);
      room.host = null;
      if (room.client) room.client.send(JSON.stringify({ type: 'peer_gone' }));
    } else if (ws === room.client) {
      console.log(`[relay] Client left   room=${code}`);
      room.client = null;
      if (room.host) room.host.send(JSON.stringify({ type: 'peer_gone' }));
    }
    pruneRoom(code);
  });
});

httpServer.listen(port, () => {
  console.log(`[relay] Conqueror relay server listening on port ${port}`);
});
