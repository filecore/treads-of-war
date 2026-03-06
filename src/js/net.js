// net.js — WebRTC LAN networking (Option B: state broadcast)
//
// Architecture:
//   Host runs authoritative simulation. At LAN_SNAP_HZ per second the host
//   serialises all tank states and broadcasts them to the client via a WebRTC
//   data channel. The client sends its raw input to the host every frame; the
//   host applies that input to the client's tank. No client-side prediction —
//   the host is fully authoritative.
//
// Signalling:
//   Requires signalling-server.js running on the host machine (default port
//   8765). Both peers connect to ws://[host-ip]:8765. The server relays SDP
//   and ICE candidates. Once the data channel is open the signalling WebSocket
//   is no longer needed for gameplay.
//
// Data channel:
//   Unordered, maxRetransmits=0 — fire-and-forget (UDP-like). Old snapshots
//   are silently dropped; only the freshest state matters.

export const LAN_SNAP_HZ = 20;  // snapshots broadcast per second

export class Net {
  constructor() {
    this.role      = null;   // 'host' | 'client'
    this.connected = false;

    // Callbacks set by caller
    this.onConnect    = null;  // ()          → void
    this.onDisconnect = null;  // ()          → void
    this.onPeerHello  = null;  // (tankKey)   → void  — peer announced their tank

    this._pc      = null;      // RTCPeerConnection
    this._channel = null;      // RTCDataChannel
    this._ws      = null;      // WebSocket (signalling only)

    // Host side: last decoded input received from client
    this.clientInput   = null;
    this.clientEchoTs  = 0;    // echo of snapshot timestamp from client (for RTT)

    // Client side: latest snapshot waiting to be consumed
    this._pendingSnap  = null;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Host: open game and wait for client. */
  async host(sigUrl) {
    this.role = 'host';
    await this._connect(sigUrl, true);
  }

  /** Client: join an existing hosted game. */
  async join(sigUrl) {
    this.role = 'client';
    await this._connect(sigUrl, false);
  }

  /** Announce local tank type to peer. Call once after onConnect fires. */
  sendHello(tankKey) {
    this._send({ t: 'h', k: tankKey });
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
    if (this._ws)      { try { this._ws.close();      } catch { /**/ } this._ws      = null; }
    if (this._channel) { try { this._channel.close(); } catch { /**/ } this._channel = null; }
    if (this._pc)      { try { this._pc.close();      } catch { /**/ } this._pc      = null; }
    this.connected = false;
    this.role      = null;
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  _send(obj) {
    if (this._channel && this._channel.readyState === 'open') {
      try { this._channel.send(JSON.stringify(obj)); } catch { /**/ }
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
      // Echo timestamp for RTT measurement
      this.clientEchoTs = d.e ?? 0;

    } else if (msg.t === 'h') {
      // Hello: peer announced their tank type
      if (this.onPeerHello) this.onPeerHello(msg.k);

    } else if (msg.t === 'peer_gone') {
      this.connected = false;
      if (this.onDisconnect) this.onDisconnect();
    }
  }

  _setupChannel(ch) {
    ch.onopen    = () => { this.connected = true;  if (this.onConnect)    this.onConnect();    };
    ch.onclose   = () => { this.connected = false; if (this.onDisconnect) this.onDisconnect(); };
    ch.onmessage = e  => this._onMessage(e.data);
  }

  async _connect(sigUrl, isHost) {
    this._pc = new RTCPeerConnection({ iceServers: [] });

    if (isHost) {
      this._channel = this._pc.createDataChannel('game', {
        ordered: false, maxRetransmits: 0,
      });
      this._setupChannel(this._channel);
    } else {
      this._pc.ondatachannel = e => {
        this._channel = e.channel;
        this._setupChannel(this._channel);
      };
    }

    // Buffer ICE candidates received before remote description is applied
    const iceBuf = [];
    let   remSet = false;

    const applyIce = async c => {
      try { await this._pc.addIceCandidate(c); } catch { /**/ }
    };

    this._pc.onicecandidate = e => {
      if (e.candidate) {
        this._ws.send(JSON.stringify({ type: 'ice', c: e.candidate }));
      }
    };

    // ── Open signalling WebSocket ─────────────────────────────────────────────
    this._ws = new WebSocket(sigUrl);

    await new Promise((res, rej) => {
      this._ws.onopen  = res;
      this._ws.onerror = () => rej(new Error(`Cannot reach signalling server at ${sigUrl}`));
    });

    this._ws.send(JSON.stringify({ type: 'role', role: isHost ? 'host' : 'client' }));

    this._ws.onmessage = async e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'ready' && isHost) {
        // Both peers registered — host creates the WebRTC offer
        const offer = await this._pc.createOffer();
        await this._pc.setLocalDescription(offer);
        this._ws.send(JSON.stringify({ type: 'offer', sdp: this._pc.localDescription }));

      } else if (msg.type === 'offer' && !isHost) {
        await this._pc.setRemoteDescription(msg.sdp);
        remSet = true;
        for (const c of iceBuf) await applyIce(c);
        iceBuf.length = 0;
        const answer = await this._pc.createAnswer();
        await this._pc.setLocalDescription(answer);
        this._ws.send(JSON.stringify({ type: 'answer', sdp: this._pc.localDescription }));

      } else if (msg.type === 'answer' && isHost) {
        await this._pc.setRemoteDescription(msg.sdp);
        remSet = true;
        for (const c of iceBuf) await applyIce(c);
        iceBuf.length = 0;

      } else if (msg.type === 'ice') {
        if (remSet) await applyIce(msg.c);
        else        iceBuf.push(msg.c);

      } else if (msg.type === 'peer_gone') {
        this.connected = false;
        if (this.onDisconnect) this.onDisconnect();
      }
    };
  }
}
