#!/usr/bin/env node
// signalling-server.js — WebRTC signalling relay for Conqueror LAN play
//
// Run:   node signalling-server.js [port]   (default port: 8765)
//
// This server does two jobs:
//   1. HTTP GET /discover — lets browsers scan the subnet for a waiting host.
//      Returns JSON: { name, hostWaiting }. CORS open so any LAN origin can fetch.
//   2. WebSocket — relays SDP offer/answer and ICE candidates between one host
//      and one client. Once the data channel is open, all game traffic flows
//      directly between the two browsers — this server is no longer involved.
//
// Prerequisites:  npm install ws   (or: npm init -y && npm install ws)

const http = require('http');
const { WebSocketServer } = require('ws');

const port = parseInt(process.argv[2] || '8765', 10);

let peers = { host: null, client: null };

// ── HTTP server (discovery endpoint) ─────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // Open CORS so browsers on any LAN origin can reach us
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  if (req.method === 'GET' && req.url === '/discover') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'Conqueror LAN Server',
      hostWaiting: peers.host !== null && peers.client === null,
    }));
    return;
  }

  res.writeHead(404); res.end();
});

// ── WebSocket server (signalling) ─────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

function relay(from, rawMsg) {
  const target = from === peers.host ? peers.client : peers.host;
  if (target && target.readyState === 1 /* OPEN */) target.send(rawMsg);
}

wss.on('connection', ws => {
  console.log('[sig] Peer connected');

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'role') {
      if (msg.role === 'host') {
        peers.host = ws;
        console.log('[sig] Host registered');
        // If client already waiting, trigger the offer flow
        if (peers.client) {
          peers.host.send(JSON.stringify({ type: 'ready' }));
          peers.client.send(JSON.stringify({ type: 'ready' }));
        }
      } else if (msg.role === 'client') {
        peers.client = ws;
        console.log('[sig] Client registered');
        if (peers.host) {
          peers.host.send(JSON.stringify({ type: 'ready' }));
          peers.client.send(JSON.stringify({ type: 'ready' }));
        }
      }
    } else {
      // Relay offer / answer / ice verbatim to the other peer
      relay(ws, raw);
    }
  });

  ws.on('close', () => {
    if (ws === peers.host) {
      console.log('[sig] Host disconnected');
      peers.host = null;
      if (peers.client) peers.client.send(JSON.stringify({ type: 'peer_gone' }));
    } else if (ws === peers.client) {
      console.log('[sig] Client disconnected');
      peers.client = null;
      if (peers.host) peers.host.send(JSON.stringify({ type: 'peer_gone' }));
    }
    // Reset both slots so a fresh pair can connect
    if (!peers.host && !peers.client) console.log('[sig] Ready for new session');
  });
});

httpServer.listen(port, () => {
  console.log(`[sig] Conqueror signalling server on port ${port}`);
  console.log(`[sig]   WebSocket:  ws://0.0.0.0:${port}`);
  console.log(`[sig]   Discovery:  http://0.0.0.0:${port}/discover`);
  console.log('[sig] Share your LAN IP with the other player, both open the game, then connect.');
});
