import { Peer } from 'peerjs';
import { MAX_KARTS, ROOM_PREFIX } from '../game/constants.js';
import { sanitizeLook } from '../game/Cosmetics.js';

const FAST_CHANNEL_ID = 101; // negotiated SCTP stream id, well clear of PeerJS' own channel
const MAX_BUFFERED = 64 * 1024; // drop state packets rather than queue them behind congestion
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PEER_OPTIONS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },
};

function randomCode(len = 6) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

/**
 * Star topology over WebRTC (PeerJS for signalling).
 *
 * Each client holds one connection to the host with two data channels:
 *  - reliable/ordered (PeerJS JSON)            → lobby, race control, item events
 *  - unreliable/unordered (ordered:false, maxRetransmits:0, raw binary) → 30 Hz kart state
 *
 * The unreliable channel is a pre-negotiated RTCDataChannel on the same RTCPeerConnection,
 * because PeerJS itself cannot express `maxRetransmits: 0`.
 *
 * Events: 'roster' (players), 'message' (msg, fromSlot), 'state' (ArrayBuffer, fromSlot),
 *         'peer-left' (slot), 'disconnected' (reason), 'error' (err)
 */
export class NetworkManager {
  constructor() {
    this.peer = null;
    this.isHost = false;
    this.roomCode = '';
    this.localSlot = 0;
    this.localName = 'Player';
    this.localLook = null; // kart cosmetics, shared through the roster
    this.players = []; // [{ slot, name }]
    this.clients = new Map(); // host: slot -> { conn, fast, name }
    this.hostConn = null;
    this.hostFast = null;
    this.acceptingPlayers = true;
    this._handlers = new Map();
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(fn);
    return this;
  }

  _emit(event, ...args) {
    const list = this._handlers.get(event);
    if (list) for (const fn of list) fn(...args);
  }

  get connected() {
    return this.isHost ? !!this.peer : !!(this.hostConn && this.hostConn.open);
  }

  // ------------------------------------------------------------------ host

  host(name, look) {
    this.destroy();
    this.isHost = true;
    this.localSlot = 0;
    this.localName = name;
    this.localLook = sanitizeLook(look);
    this.players = [{ slot: 0, name, look: this.localLook }];
    this.acceptingPlayers = true;

    return new Promise((resolve, reject) => {
      const attempt = (tries) => {
        const code = randomCode();
        const peer = new Peer(ROOM_PREFIX + code, PEER_OPTIONS);
        let settled = false;
        peer.on('open', () => {
          settled = true;
          this.peer = peer;
          this.roomCode = code;
          peer.on('connection', (conn) => this._onIncoming(conn));
          peer.on('disconnected', () => {
            // Lost the signalling server; existing WebRTC links keep working. Try to reconnect.
            if (!peer.destroyed) peer.reconnect();
          });
          resolve(code);
        });
        peer.on('error', (err) => {
          if (!settled && err.type === 'unavailable-id' && tries < 4) {
            peer.destroy();
            attempt(tries + 1);
          } else if (!settled) {
            peer.destroy();
            reject(err);
          } else {
            this._emit('error', err);
          }
        });
      };
      attempt(0);
    });
  }

  _freeSlot() {
    for (let s = 1; s < MAX_KARTS; s++) if (!this.clients.has(s)) return s;
    return -1;
  }

  _onIncoming(conn) {
    conn.on('open', () => {
      const slot = this._freeSlot();
      if (!this.acceptingPlayers || slot < 0) {
        conn.send({ t: 'reject', reason: slot < 0 ? 'Room is full.' : 'Race already in progress.' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      const name = String(conn.metadata?.name || `Player ${slot + 1}`).slice(0, 16);
      const fast = this._openFastChannel(conn, (data) => this._emit('state', data, slot));
      this.clients.set(slot, { conn, fast, name, look: sanitizeLook(conn.metadata?.look) });
      this._rebuildRoster();
      conn.send({ t: 'welcome', slot, players: this.players });
      this.broadcast({ t: 'roster', players: this.players });
      this._emit('roster', this.players);

      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'look') {
          const c = this.clients.get(slot);
          if (c) c.look = sanitizeLook(msg.look);
          this._publishRoster();
          return;
        }
        this._emit('message', msg, slot);
      });
      const drop = () => this._dropClient(slot, conn);
      conn.on('close', drop);
      conn.on('error', drop);
      conn.peerConnection?.addEventListener('connectionstatechange', () => {
        const st = conn.peerConnection?.connectionState;
        if (st === 'failed' || st === 'closed') drop();
      });
    });
  }

  _dropClient(slot, conn) {
    const c = this.clients.get(slot);
    if (!c || c.conn !== conn) return;
    this.clients.delete(slot);
    try { c.fast?.close(); } catch { /* already closed */ }
    try { conn.close(); } catch { /* already closed */ }
    this._rebuildRoster();
    this.broadcast({ t: 'roster', players: this.players });
    this._emit('peer-left', slot);
    this._emit('roster', this.players);
  }

  _publishRoster() {
    this._rebuildRoster();
    this.broadcast({ t: 'roster', players: this.players });
    this._emit('roster', this.players);
  }

  /** Update our kart's cosmetics for everyone in the room. */
  setLook(look) {
    this.localLook = sanitizeLook(look);
    if (this.isHost) {
      if (this.peer) this._publishRoster();
    } else {
      this.send({ t: 'look', look: this.localLook });
    }
  }

  _rebuildRoster() {
    this.players = [{ slot: 0, name: this.localName, look: this.localLook }];
    for (const [slot, c] of this.clients) this.players.push({ slot, name: c.name, look: c.look });
    this.players.sort((a, b) => a.slot - b.slot);
  }

  // ------------------------------------------------------------------ client

  join(code, name, look) {
    this.destroy();
    this.isHost = false;
    this.localName = name;
    this.localLook = sanitizeLook(look);
    const roomCode = code.trim().toUpperCase();
    this.roomCode = roomCode;

    return new Promise((resolve, reject) => {
      const peer = new Peer(PEER_OPTIONS);
      this.peer = peer;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const timeout = setTimeout(() => fail(new Error('Timed out connecting to host.')), 15000);

      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') fail(new Error(`Room ${roomCode} not found.`));
        else if (!settled) fail(err);
        else this._emit('error', err);
      });
      peer.on('open', () => {
        const conn = peer.connect(ROOM_PREFIX + roomCode, {
          reliable: true,
          serialization: 'json',
          metadata: { name, look: this.localLook },
        });
        this.hostConn = conn;
        conn.on('open', () => {
          this.hostFast = this._openFastChannel(conn, (data) => this._emit('state', data, 0));
        });
        conn.on('data', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.t === 'welcome') {
            clearTimeout(timeout);
            settled = true;
            this.localSlot = msg.slot;
            this.players = msg.players;
            this._emit('roster', this.players);
            resolve(msg.slot);
            return;
          }
          if (msg.t === 'reject') {
            clearTimeout(timeout);
            fail(new Error(msg.reason));
            return;
          }
          if (msg.t === 'roster') {
            this.players = msg.players;
            this._emit('roster', this.players);
            return;
          }
          this._emit('message', msg, 0);
        });
        const lost = () => {
          if (!settled) { clearTimeout(timeout); fail(new Error('Connection to host closed.')); return; }
          if (this.hostConn === conn) {
            this.hostConn = null;
            this._emit('disconnected', 'Host left the room.');
          }
        };
        conn.on('close', lost);
        conn.on('error', lost);
      });
    });
  }

  // ------------------------------------------------------------------ channels

  _openFastChannel(conn, onData) {
    const pc = conn.peerConnection;
    if (!pc) return null;
    const dc = pc.createDataChannel('kart-state', {
      negotiated: true,
      id: FAST_CHANNEL_ID,
      ordered: false,
      maxRetransmits: 0,
    });
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e) => onData(e.data);
    return dc;
  }

  _sendFast(dc, view) {
    if (dc && dc.readyState === 'open' && dc.bufferedAmount < MAX_BUFFERED) {
      try { dc.send(view); } catch { /* channel closing */ }
    }
  }

  /** Client → host kart state (binary, unreliable). */
  sendState(view) {
    this._sendFast(this.hostFast, view);
  }

  /** Host → every client snapshot (binary, unreliable). */
  broadcastState(view) {
    for (const c of this.clients.values()) this._sendFast(c.fast, view);
  }

  /** Client → host reliable message. */
  send(msg) {
    if (this.hostConn && this.hostConn.open) this.hostConn.send(msg);
  }

  /** Host → all clients reliable message. */
  broadcast(msg) {
    for (const c of this.clients.values()) if (c.conn.open) c.conn.send(msg);
  }

  shareLink() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', this.roomCode);
    return url.toString();
  }

  destroy() {
    // Detach references first so close events fired below are treated as intentional.
    const clients = [...this.clients.values()];
    this.clients.clear();
    const hostConn = this.hostConn, hostFast = this.hostFast;
    this.hostConn = null;
    this.hostFast = null;
    for (const c of clients) {
      try { c.fast?.close(); } catch { /* ignore */ }
      try { c.conn.close(); } catch { /* ignore */ }
    }
    try { hostFast?.close(); } catch { /* ignore */ }
    try { hostConn?.close(); } catch { /* ignore */ }
    if (this.peer && !this.peer.destroyed) this.peer.destroy();
    this.peer = null;
    this.players = [];
    this.roomCode = '';
  }
}
