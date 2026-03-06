// net.js — WebSocket LAN networking (relay through games server)
//
// Architecture:
//   A relay-server.js process runs permanently on the LAN games server.
//   Both players connect to it via WebSocket; all game traffic is relayed
//   through the server. No WebRTC, no local server needed on player machines.
//
// Rooms:
//   Each game session is identified by a 4-char room code. Host generates
//   the code; client enters it. The relay server pairs them by code.
//
// Transport:
//   Messages are plain JSON strings. The relay forwards them verbatim.
//   Fire-and-forget is no longer possible (TCP-backed WebSocket is reliable
//   and ordered), but on a LAN this makes no practical difference.

export const LAN_SNAP_HZ = 20;  // snapshots broadcast per second

export class Net {
  constructor() {
    this.role      = null;   // 'host' | 'client'
    this.connected = false;
    this.roomCode  = null;

    // Callbacks set by caller
    this.onConnect     = null;  // ()              → void
    this.onDisconnect  = null;  // ()              → void
    this.onPeerHello   = null;  // (tankKey, name) → void
    this.onServerError = null;  // (message)       → void

    this._ws = null;   // WebSocket to relay server

    // Host side: last decoded input received from client
    this.clientInput  = null;
    this.clientEchoTs = 0;

    // Client side: latest snapshot waiting to be consumed
    this._pendingSnap = null;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Host: open game and wait for client. */
  async host(serverUrl, roomCode) {
    this.role     = 'host';
    this.roomCode = roomCode;
    await this._connect(serverUrl, 'host', roomCode);
  }

  /** Client: join a hosted game by room code. */
  async join(serverUrl, roomCode) {
    this.role     = 'client';
    this.roomCode = roomCode;
    await this._connect(serverUrl, 'client', roomCode);
  }

  /** Announce local tank type and player name to peer. Call once after onConnect fires. */
  sendHello(tankKey, name = '') {
    this._send({ t: 'h', k: tankKey, n: name });
  }

  /** Host → client: broadcast authoritative game state. */
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
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify(obj)); } catch { /**/ }
    }
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 's') {
      // Snapshot: host → client; keep only the latest
      this._pendingSnap = msg.d;

    } else if (msg.t === 'i') {
      // Input: client → host; decode into a tank-ready input object
      const d = msg.d;
      this.clientInput = {
        leftFwd:     !!d.lf,  leftBwd:     !!d.lb,
        rightFwd:    !!d.rf,  rightBwd:    !!d.rb,
        turretLeft:  !!d.tl,  turretRight: !!d.tr,
        fire:        !!d.fi,  fireOnce:    !!d.fo,
        skipAccel: false,
      };
      this.clientEchoTs = d.e ?? 0;

    } else if (msg.t === 'h') {
      // Hello: peer announced their tank type and name
      if (this.onPeerHello) this.onPeerHello(msg.k, msg.n || '');
    }
  }

  async _connect(serverUrl, role, roomCode) {
    this._ws = new WebSocket(serverUrl);

    await new Promise((res, rej) => {
      this._ws.onopen  = res;
      this._ws.onerror = () => rej(new Error(`Cannot reach relay server at ${serverUrl}`));
    });

    // Register with the relay server
    this._ws.send(JSON.stringify({ type: 'role', role, room: roomCode }));

    this._ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'connected') {
        // Both peers are in the room — game can start
        this.connected = true;
        if (this.onConnect) this.onConnect();

      } else if (msg.type === 'peer_gone') {
        this.connected = false;
        if (this.onDisconnect) this.onDisconnect();

      } else if (msg.type === 'error') {
        if (this.onServerError) this.onServerError(msg.msg || 'Server error');

      } else {
        // Game message (snapshot / input / hello) — route to game handler
        this._onMessage(e.data);
      }
    };

    this._ws.onclose = () => {
      if (this.connected) {
        this.connected = false;
        if (this.onDisconnect) this.onDisconnect();
      }
    };
  }
}
