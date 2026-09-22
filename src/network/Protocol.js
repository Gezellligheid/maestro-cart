import { MAX_KARTS } from '../game/constants.js';

/**
 * Binary kart-state packets for the unreliable channel.
 *
 * Header (4 bytes): u8 type, u8 count, u16 sequence
 * Record (44 bytes, little endian):
 *   0 u8 slot | 1 u8 flags | 2 u8 driftTier (low nibble) + shrink/shield/magnet bits | 3 u8 item
 *   4 u32 sender time (ms)
 *   8 f32 x | 12 f32 y | 16 f32 z | 20 f32 yaw
 *  24 f32 vx | 28 f32 vy | 32 f32 vz | 36 f32 progress
 *  40 u8 lap | 41 u8 coins | 42 i8 steer*100 | 43 u8 rank
 */
export const PKT_CLIENT_STATE = 1;
export const PKT_SNAPSHOT = 2;
export const HEADER_BYTES = 4;
export const RECORD_BYTES = 44;

/** Plain decoded record; one instance per slot is reused forever. */
export class KartRecord {
  constructor() {
    this.slot = 0; this.flags = 0; this.driftTier = 0; this.item = 0;
    this.time = 0;
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.progress = 0; this.lap = 0; this.coins = 0; this.steer = 0; this.rank = 0;
    this.valid = false;
  }

  copyFrom(r) {
    this.slot = r.slot; this.flags = r.flags; this.driftTier = r.driftTier; this.item = r.item;
    this.time = r.time;
    this.x = r.x; this.y = r.y; this.z = r.z; this.yaw = r.yaw;
    this.vx = r.vx; this.vy = r.vy; this.vz = r.vz;
    this.progress = r.progress; this.lap = r.lap; this.coins = r.coins; this.steer = r.steer; this.rank = r.rank;
    this.valid = true;
    return this;
  }

  fromKart(k, time) {
    // Upper nibble of the drift-tier byte carries shrink / shield / magnet state.
    this.slot = k.slot; this.flags = k.flags; this.driftTier = k.driftTier | (k.extraBits << 4);
    this.item = k.rollTimer > 0 ? 0 : k.item;
    this.time = time;
    this.x = k.x; this.y = k.y; this.z = k.z; this.yaw = k.yaw;
    this.vx = k.vx; this.vy = k.vy; this.vz = k.vz;
    this.progress = k.progress; this.lap = k.lap; this.coins = k.coins;
    this.steer = k.steerVisual; this.rank = k.rank;
    this.valid = true;
    return this;
  }
}

/** Encoder with a single preallocated buffer; no allocation per packet. */
export class PacketWriter {
  constructor() {
    this.buffer = new ArrayBuffer(HEADER_BYTES + RECORD_BYTES * MAX_KARTS);
    this.view = new DataView(this.buffer);
    // Pre-built views for every possible record count.
    this.views = [];
    for (let n = 0; n <= MAX_KARTS; n++) this.views.push(new Uint8Array(this.buffer, 0, HEADER_BYTES + RECORD_BYTES * n));
    this.count = 0;
    this.seq = 0;
  }

  begin() {
    this.count = 0;
  }

  write(r) {
    const v = this.view;
    const o = HEADER_BYTES + this.count * RECORD_BYTES;
    v.setUint8(o, r.slot);
    v.setUint8(o + 1, r.flags);
    v.setUint8(o + 2, r.driftTier);
    v.setUint8(o + 3, r.item);
    v.setUint32(o + 4, r.time >>> 0, true);
    v.setFloat32(o + 8, r.x, true);
    v.setFloat32(o + 12, r.y, true);
    v.setFloat32(o + 16, r.z, true);
    v.setFloat32(o + 20, r.yaw, true);
    v.setFloat32(o + 24, r.vx, true);
    v.setFloat32(o + 28, r.vy, true);
    v.setFloat32(o + 32, r.vz, true);
    v.setFloat32(o + 36, r.progress, true);
    v.setUint8(o + 40, Math.min(255, r.lap));
    v.setUint8(o + 41, r.coins);
    v.setInt8(o + 42, Math.round(Math.max(-1, Math.min(1, r.steer)) * 100));
    v.setUint8(o + 43, r.rank);
    this.count++;
  }

  finish(type) {
    this.view.setUint8(0, type);
    this.view.setUint8(1, this.count);
    this.seq = (this.seq + 1) & 0xffff;
    this.view.setUint16(2, this.seq, true);
    return this.views[this.count];
  }
}

const _scratch = new KartRecord();

/**
 * Decode a packet, invoking `onRecord(record)` for each kart. The record object is reused,
 * so callers must copy what they need. Returns the packet type or -1 if malformed.
 */
export function readPacket(buffer, onRecord) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_BYTES) return -1;
  const v = new DataView(buffer);
  const type = v.getUint8(0);
  const count = v.getUint8(1);
  if (count > MAX_KARTS || buffer.byteLength < HEADER_BYTES + count * RECORD_BYTES) return -1;
  const r = _scratch;
  for (let i = 0; i < count; i++) {
    const o = HEADER_BYTES + i * RECORD_BYTES;
    r.slot = v.getUint8(o);
    r.flags = v.getUint8(o + 1);
    r.driftTier = v.getUint8(o + 2);
    r.item = v.getUint8(o + 3);
    r.time = v.getUint32(o + 4, true);
    r.x = v.getFloat32(o + 8, true);
    r.y = v.getFloat32(o + 12, true);
    r.z = v.getFloat32(o + 16, true);
    r.yaw = v.getFloat32(o + 20, true);
    r.vx = v.getFloat32(o + 24, true);
    r.vy = v.getFloat32(o + 28, true);
    r.vz = v.getFloat32(o + 32, true);
    r.progress = v.getFloat32(o + 36, true);
    r.lap = v.getUint8(o + 40);
    r.coins = v.getUint8(o + 41);
    r.steer = v.getInt8(o + 42) / 100;
    r.rank = v.getUint8(o + 43);
    if (r.slot < MAX_KARTS && Number.isFinite(r.x) && Number.isFinite(r.z)) onRecord(r);
  }
  return type;
}
