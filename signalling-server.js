#!/usr/bin/env node
// signalling-server.js — WebRTC signalling relay for Conqueror LAN play
//
// Run:   node signalling-server.js [port]   (default port: 8765)
//
// This tiny server relays SDP offer/answer and ICE candidates between exactly
// two peers (one host, one client) so they can establish a direct WebRTC
// data channel. Once the data channel is open, all game traffic flows directly
// between the two browsers — this server is no longer involved.
//
// Prerequisites:  npm install ws   (or: npm init -y && npm install ws)

const { WebSocketServer } = require('ws');
const port = parseInt(process.argv[2] || '8765', 10);
const wss  = new WebSocketServer({ port });

let peers = { host: null, client: null };

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

console.log(`[sig] Conqueror signalling server on ws://0.0.0.0:${port}`);
console.log('[sig] Share your LAN IP with the other player, both open the game, then connect.');
