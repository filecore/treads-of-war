// net.js — WebSocket LAN networking (relay through games server, N-player)
//
// Architecture:
//   A relay-server.js process runs permanently on the LAN games server.
//   All players connect to it via WebSocket; all game traffic is relayed.
//   Host is authoritative: runs simulation, broadcasts snapshots at 20Hz.
//   Clients send inputs; relay forwards inputs to host only.
//
// Rooms:
//   Each game session is identified by a 4-char room code. Host generates
//   the code; clients enter it. The relay pairs them by code.
//
// Player IDs:
//   Host always has id='h'. Clients get id='p1','p2','p3',... assigned
//   by the relay at join time.

export const LAN_SNAP_HZ = 20;  // snapshots broadcast per second

export class Net {
  constructor() {
    this.id        = null;   // own player ID: 'h' for host, 'pN' for clients
    this.role      = null;   // 'host' | 'client'
    this.connected = false;  // true once relay registration confirmed
    this.roomCode  = null;
    this.maxPlayers = 2;

    // Set of peer IDs currently in the room (excludes self)
    this.peerIds = new Set();

    // Callbacks set by caller
    this.onJoined      = null;  // (id, role, peers)  → void  — registered with relay
    this.onPeerJoined  = null;  // (id)               → void  — someone else joined
    this.onPeerLeft    = null;  // (id)               → void  — someone else left
    this.onHostGone    = null;  // ()                 → void  — host disconnected
    this.onGameMessage = null;  // (from, msg)        → void  — game data (t:'h','i','s', etc.)
    this.onServerError = null;  // (message)          → void

    this._ws = null;

    // Host side: latest decoded inputs per client, and echo timestamps
    this.clientInputs  = new Map();  // id → InputObject
    this.clientEchoTs  = new Map();  // id → number (timestamp)

    // Client side: latest snapshot waiting to be consumed
    this._pendingSnap = null;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Host: open game and wait for players. maxPlayers: 2–16. */
  async host(serverUrl, roomCode, maxPlayers = 2) {
    this.role       = 'host';
    this.id         = 'h';
    this.roomCode   = roomCode;
    this.maxPlayers = maxPlayers;
    await this._connect(serverUrl, 'host', roomCode, maxPlayers);
  }

  /** Client: join a hosted game by room code. */
  async join(serverUrl, roomCode) {
    this.role     = 'client';
    this.roomCode = roomCode;
    await this._connect(serverUrl, 'client', roomCode);
  }

  /** Announce local tank type, player name, and team to all peers. Call after onJoined fires. */
  sendHello(tankKey, name = '', team = 0) {
    this._send({ t: 'h', k: tankKey, n: name, tm: team });
  }

  /** Host → all clients: broadcast authoritative game state. */
  sendSnapshot(snap) {
    this._send({ t: 's', d: snap });
  }

  /**
   * Client → host: send local player input every frame.
   * echoTs: timestamp from the last received snapshot (for RTT measurement).
   */
  sendInput(inp, echoTs = 0) {
    this._send({
      t: 'i',
      d: {
        lf: inp.leftFwd     ? 1 : 0,
        lb: inp.leftBwd     ? 1 : 0,
        rf: inp.rightFwd    ? 1 : 0,
        rb: inp.rightBwd    ? 1 : 0,
        tl: inp.turretLeft  ? 1 : 0,
        tr: inp.turretRight ? 1 : 0,
        fi: inp.fire        ? 1 : 0,
        fo: inp.fireOnce    ? 1 : 0,
        e:  echoTs,
      },
    });
  }

  /** Host: send start signal so all clients transition to gameplay.
   *  mode: optional game mode string, e.g. 'ctf'. */
  sendStart(rosterMap, mode = '') {
    // rosterMap: Map<id, {tankKey, name, team}>
    const roster = {};
    for (const [id, p] of rosterMap) roster[id] = { k: p.tankKey, n: p.name, tm: p.team };
    this._send({ t: 'start', roster, mode });
  }

  /** Host: broadcast current roster to all clients (call after any roster change in lobby). */
  sendRoster(rosterMap) {
    const roster = {};
    for (const [id, p] of rosterMap) roster[id] = { k: p.tankKey, n: p.name, tm: p.team };
    this._send({ t: 'roster', roster });
  }

  /**
   * Client: consume the latest snapshot.
   * Returns the snapshot object, or null if nothing new since last call.
   */
  consumeSnapshot() {
    const s = this._pendingSnap;
    this._pendingSnap = null;
    return s;
  }

  isHost()   { return this.role === 'host';   }
  isClient() { return this.role === 'client'; }

  disconnect() {
    if (this._ws) { try { this._ws.close(); } catch { /**/ } this._ws = null; }
    this.connected = false;
    this.role      = null;
    this.id        = null;
    this.peerIds.clear();
    this.clientInputs.clear();
    this.clientEchoTs.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify(obj)); } catch { /**/ }
    }
  }

  _onGameMessage(from, msg) {
    if (msg.t === 's') {
      // Snapshot: host → client; keep only the latest
      this._pendingSnap = msg.d;

    } else if (msg.t === 'i') {
      // Input: client → host; decode into tank-ready input object
      const d = msg.d || {};
      this.clientInputs.set(from, {
        leftFwd:     !!d.lf,  leftBwd:     !!d.lb,
        rightFwd:    !!d.rf,  rightBwd:    !!d.rb,
        turretLeft:  !!d.tl,  turretRight: !!d.tr,
        fire:        !!d.fi,  fireOnce:    !!d.fo,
        skipAccel: false,
      });
      this.clientEchoTs.set(from, d.e ?? 0);

    } else {
      // Hello, start, or other game message — pass to caller
      if (this.onGameMessage) this.onGameMessage(from, msg);
    }
  }

  async _connect(serverUrl, role, roomCode, maxPlayers) {
    this._ws = new WebSocket(serverUrl);

    await new Promise((res, rej) => {
      this._ws.onopen  = res;
      this._ws.onerror = () => rej(new Error('Cannot reach relay server — check your connection'));
    });

    // Register with the relay server
    const regMsg = { type: 'role', role, room: roomCode };
    if (role === 'host' && maxPlayers) regMsg.maxPlayers = maxPlayers;
    this._ws.send(JSON.stringify(regMsg));

    this._ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'joined') {
        // Relay confirmed registration + assigned our ID
        this.id        = msg.id;
        this.connected = true;
        if (msg.peers) msg.peers.forEach(id => this.peerIds.add(id));
        if (this.onJoined) this.onJoined(msg.id, msg.role, msg.peers || []);

      } else if (msg.type === 'peer_joined') {
        this.peerIds.add(msg.id);
        if (this.onPeerJoined) this.onPeerJoined(msg.id);

      } else if (msg.type === 'peer_left') {
        this.peerIds.delete(msg.id);
        this.clientInputs.delete(msg.id);
        this.clientEchoTs.delete(msg.id);
        if (this.onPeerLeft) this.onPeerLeft(msg.id);

      } else if (msg.type === 'host_gone') {
        this.connected = false;
        if (this.onHostGone) this.onHostGone();

      } else if (msg.type === 'error') {
        if (this.onServerError) this.onServerError(msg.msg || 'Server error');

      } else if (msg.from !== undefined) {
        // Game message with injected 'from' field
        this._onGameMessage(msg.from, msg);
      }
    };

    this._ws.onclose = () => {
      if (this.connected) {
        this.connected = false;
        if (this.role === 'client' && this.onHostGone) this.onHostGone();
        else if (this.onPeerLeft) { /* handled per-peer above */ }
      }
    };
  }
}
