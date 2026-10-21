import test from "node:test";
import assert from "node:assert/strict";

import {
  BINARY_FRAME_LEN,
  BINARY_LIVE_V2_FRAME_LEN,
  BINARY_LIVE_V2_GYRO_FRAME_LEN,
  LIVE_V2_GYRO_TYPE,
  decodeBinaryFrame,
  parseBinaryFrame,
  parseBinaryLiveV2Frame,
  parseBinaryTraceStatusFrame,
  quaternionToEulerDeg,
} from "../app/protocol/frame.js";

function frame29(type) {
  const bytes = new Uint8Array(BINARY_FRAME_LEN);
  bytes[0] = 0x4f;
  bytes[1] = 0x46;
  bytes[2] = 1;
  bytes[3] = type;
  return bytes;
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function setU16(bytes, offset, value) {
  view(bytes).setUint16(offset, value, true);
}

function setI16(bytes, offset, value) {
  view(bytes).setInt16(offset, value, true);
}

// Build one v2 live frame body. The 20-byte type-1 frame stops after micAmp;
// the 26-byte type-8 frame appends the Q4 gyro triple.
function liveV2Body({
  type,
  length,
  sequence,
  dtUs = 900,
  axDeciG = 0,
  ayDeciG = 0,
  azDeciG = 10,
  quat = [10000, 0, 0, 0],
  micAmp = 0,
  gyroQ4 = null,
}) {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x4f;
  bytes[1] = 0x46;
  bytes[2] = 2;
  bytes[3] = type;
  setU16(bytes, 4, sequence);
  setU16(bytes, 6, dtUs);
  bytes[8] = axDeciG & 0xff;
  bytes[9] = ayDeciG & 0xff;
  bytes[10] = azDeciG & 0xff;
  for (let i = 0; i < quat.length; i++) {
    setI16(bytes, 11 + i * 2, quat[i]);
  }
  bytes[19] = micAmp;
  if (gyroQ4) {
    setI16(bytes, 20, gyroQ4[0]);
    setI16(bytes, 22, gyroQ4[1]);
    setI16(bytes, 24, gyroQ4[2]);
  }
  return bytes;
}

function liveV2Frame(options) {
  return liveV2Body({
    ...options,
    type: 1,
    length: BINARY_LIVE_V2_FRAME_LEN,
  });
}

function liveV2GyroFrame(options) {
  return liveV2Body({
    ...options,
    type: LIVE_V2_GYRO_TYPE,
    length: BINARY_LIVE_V2_GYRO_FRAME_LEN,
  });
}

test("parseBinaryLiveV2Frame decodes the 20-byte firmware live layout", () => {
  const sample = parseBinaryLiveV2Frame(liveV2Frame({
    sequence: 65535,
    axDeciG: -2,
    ayDeciG: 3,
    azDeciG: 10,
    micAmp: 77,
  }));

  assert.equal(sample.protocol, 2);
  assert.equal(sample.type, 1);
  assert.equal(sample.sequence, 65535);
  assert.equal(sample.dtUs, 900);
  assert.equal(sample.axMg, -200);
  assert.equal(sample.ayMg, 300);
  assert.equal(sample.azMg, 1000);
  assert.equal(sample.gyroAvailable, false);
  assert.equal(sample.qw, 1);
  assert.equal(sample.qx, 0);
  assert.equal(sample.qy, 0);
  assert.equal(sample.qz, 0);
  assert.equal(sample.rollDeg, 0);
  assert.equal(sample.pitchDeg, 0);
  assert.equal(sample.yawDeg, 0);
  assert.equal(sample.micAmp, 77);
});

test("decodeBinaryFrame walks a 120-byte batched notification as six v2 frames", () => {
  const notification = new Uint8Array(BINARY_LIVE_V2_FRAME_LEN * 6);
  const sequences = [65534, 65535, 0, 1, 2, 3];

  for (let i = 0; i < sequences.length; i++) {
    notification.set(liveV2Frame({
      sequence: sequences[i],
      micAmp: 20 + i,
      azDeciG: 10 + i,
    }), i * BINARY_LIVE_V2_FRAME_LEN);
  }

  const decoded = [];
  for (let offset = 0; offset < notification.length;) {
    const frame = decodeBinaryFrame(notification, offset);
    assert.equal(frame.kind, "sample");
    decoded.push(frame.sample);
    offset += frame.byteLength;
  }

  assert.deepEqual(decoded.map((sample) => sample.sequence), sequences);
  assert.deepEqual(decoded.map((sample) => sample.micAmp), [20, 21, 22, 23, 24, 25]);
  assert.deepEqual(decoded.map((sample) => sample.azMg), [1000, 1100, 1200, 1300, 1400, 1500]);
});

test("parseBinaryLiveV2Frame decodes the 26-byte type-8 gyro live layout", () => {
  const body = {
    sequence: 1234,
    dtUs: 901,
    axDeciG: -2,
    ayDeciG: 3,
    azDeciG: 10,
    quat: [10000, -800, 600, -400],
    micAmp: 88,
  };
  const gyro = parseBinaryLiveV2Frame(liveV2GyroFrame({ ...body, gyroQ4: [-160, 400, -1200] }));
  const plain = parseBinaryLiveV2Frame(liveV2Frame(body));

  assert.equal(gyro.type, LIVE_V2_GYRO_TYPE);
  assert.equal(gyro.gyroAvailable, true);
  assert.equal(gyro.gxDps, -10);
  assert.equal(gyro.gyDps, 25);
  assert.equal(gyro.gzDps, -75);

  // Everything except the gyro triple must match the 20-byte type-1 frame.
  for (const field of [
    "protocol", "sequence", "dtUs", "axMg", "ayMg", "azMg",
    "qw", "qx", "qy", "qz", "rollDeg", "pitchDeg", "yawDeg", "micAmp",
  ]) {
    assert.equal(gyro[field], plain[field], `${field} diverged between type 1 and type 8`);
  }

  assert.equal(plain.gyroAvailable, false);
  assert.equal(plain.gxDps, 0);
  assert.equal(plain.gyDps, 0);
  assert.equal(plain.gzDps, 0);
});

test("decodeBinaryFrame walks a 156-byte batched notification as six 26-byte gyro frames", () => {
  const notification = new Uint8Array(BINARY_LIVE_V2_GYRO_FRAME_LEN * 6);
  const sequences = [10, 11, 12, 13, 14, 15];

  for (let i = 0; i < sequences.length; i++) {
    notification.set(liveV2GyroFrame({
      sequence: sequences[i],
      micAmp: 30 + i,
      azDeciG: 10 + i,
      gyroQ4: [-16 * (i + 1), 16 * (i + 1), 16 * -(i + 1)],
    }), i * BINARY_LIVE_V2_GYRO_FRAME_LEN);
  }

  const decoded = [];
  for (let offset = 0; offset < notification.length;) {
    const frame = decodeBinaryFrame(notification, offset);
    assert.equal(frame.kind, "sample");
    assert.equal(frame.byteLength, BINARY_LIVE_V2_GYRO_FRAME_LEN);
    assert.equal(frame.sample.type, LIVE_V2_GYRO_TYPE);
    decoded.push(frame.sample);
    offset += frame.byteLength;
  }

  assert.equal(decoded.length, 6);
  assert.deepEqual(decoded.map((sample) => sample.sequence), sequences);
  assert.deepEqual(decoded.map((sample) => sample.gxDps), [-1, -2, -3, -4, -5, -6]);
  assert.deepEqual(decoded.map((sample) => sample.gyDps), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(decoded.map((sample) => sample.gzDps), [-1, -2, -3, -4, -5, -6]);
  assert.ok(decoded.every((sample) => sample.gyroAvailable === true));
});

test("26-byte type-8 frames are never decoded as phantom shot events", () => {
  const frame = liveV2GyroFrame({ sequence: 7, gyroQ4: [-160, 400, -1200] });
  assert.equal(frame.length, 26);
  assert.equal(frame[2], 2);
  assert.equal(frame[3], LIVE_V2_GYRO_TYPE, "Gyro frames must not reuse the type-2 shot event byte");

  const decoded = decodeBinaryFrame(frame);
  assert.equal(decoded.kind, "sample");
  assert.equal(decoded.byteLength, BINARY_LIVE_V2_GYRO_FRAME_LEN);
  assert.equal(decoded.shot, undefined);

  // A truncated frame must be rejected rather than misread as a shot.
  assert.equal(decodeBinaryFrame(frame.subarray(0, 25)), null);

  // Batched: 156 bytes of gyro frames yields six samples and zero shots.
  const batch = new Uint8Array(BINARY_LIVE_V2_GYRO_FRAME_LEN * 6);
  for (let i = 0; i < 6; i++) {
    batch.set(liveV2GyroFrame({ sequence: i, gyroQ4: [0, 0, 0] }), i * BINARY_LIVE_V2_GYRO_FRAME_LEN);
  }
  const kinds = [];
  for (let offset = 0; offset < batch.length;) {
    const item = decodeBinaryFrame(batch, offset);
    assert.notEqual(item, null);
    kinds.push(item.kind);
    offset += item.byteLength;
  }
  assert.equal(kinds.filter((kind) => kind === "sample").length, 6);
  assert.equal(kinds.filter((kind) => kind === "shot").length, 0);
});

test("decodeBinaryFrame decodes a 29-byte shot event frame", () => {
  const bytes = frame29(2);
  setU16(bytes, 4, 321);
  setU16(bytes, 6, 1234);
  setI16(bytes, 8, -1200);
  setI16(bytes, 10, 250);
  setI16(bytes, 12, 980);
  setU16(bytes, 14, 275);
  setI16(bytes, 16, -123);
  setI16(bytes, 18, 456);
  setI16(bytes, 20, 789);
  setU16(bytes, 22, 12);
  setU16(bytes, 24, 34);
  setU16(bytes, 26, 65535);

  assert.deepEqual(decodeBinaryFrame(bytes), {
    kind: "shot",
    byteLength: BINARY_FRAME_LEN,
    shot: {
      shotCount: 321,
      shotId: 1234,
      axMg: -1200,
      ayMg: 250,
      azMg: 980,
      thresholdG: 2.75,
      rollDeg: -1.23,
      pitchDeg: 4.56,
      yawDeg: 7.89,
      clickerDtMs: 12,
      impactDtMs: 34,
      shotSequence: 65535,
      stored: false,
    },
  });
});

test("v2 live metadata preserves full counters without changing motion or release sequence", () => {
  for (const [shotCount, shotId] of [[0, 0], [65535, 65535], [65536, 65536], [2147483647, 0xfedcba98], [0xffffffff, 0xffffffff]]) {
    const bytes = frame29(2); bytes[2] = 2;
    setU16(bytes, 4, shotCount); setU16(bytes, 6, shotId);
    setU16(bytes, 22, Math.floor(shotId / 65536)); setU16(bytes, 24, Math.floor(shotCount / 65536));
    setI16(bytes, 8, -1200); setI16(bytes, 10, 250); setI16(bytes, 12, 16000);
    setU16(bytes, 14, 325); setI16(bytes, 16, -123); setI16(bytes, 18, 456); setI16(bytes, 20, -789);
    setU16(bytes, 26, 65535);
    assert.deepEqual(decodeBinaryFrame(bytes), { kind: "shot", byteLength: 29, shot: {
      shotCount, shotId, axMg: -1200, ayMg: 250, azMg: 16000, thresholdG: 3.25,
      rollDeg: -1.23, pitchDeg: 4.56, yawDeg: -7.89,
      clickerDtMs: null, impactDtMs: null, shotSequence: 65535, stored: false,
    } });
  }
});

test("v2 count and storage metadata retain full counts in mixed legacy notifications", () => {
  const legacy = frame29(3); setU16(legacy, 4, 4321);
  const count = frame29(3); count[2] = 2; setU16(count, 4, 1); setU16(count, 24, 1);
  const storage = frame29(5); storage[2] = 2;
  setU16(storage, 4, 2); setU16(storage, 18, 1); setU16(storage, 6, 7);
  setU16(storage, 8, 0x5678); setU16(storage, 14, 0x1234);
  const mixed = new Uint8Array(87); mixed.set(legacy); mixed.set(count, 29); mixed.set(storage, 58);
  assert.equal(decodeBinaryFrame(mixed).count, 4321);
  assert.equal(decodeBinaryFrame(mixed, 29).count, 65537);
  assert.deepEqual(decodeBinaryFrame(mixed, 58).storage, {
    shotCount: 65538, pending: 7, uploadShotId: 0x12345678, requested: false, dropped: 0, retryAttempts: 0,
  });
});

test("unknown metadata versions cannot be mistaken for legacy shot acknowledgements", () => {
  for (const type of [2, 3, 4, 5]) {
    const frame = frame29(type); frame[2] = 3;
    assert.equal(decodeBinaryFrame(frame), null);
  }
  const stored = frame29(4); stored[2] = 2;
  assert.equal(decodeBinaryFrame(stored), null, "Unsupported v2 stored metadata used the legacy ID layout");
});

test("decodeBinaryFrame decodes count-sync, storage-status, stored-shot, trace-status, and trace-chunk envelopes", () => {
  const count = frame29(3);
  setU16(count, 4, 4321);
  assert.deepEqual(decodeBinaryFrame(count), {
    kind: "count",
    count: 4321,
    byteLength: BINARY_FRAME_LEN,
  });

  const storage = frame29(5);
  setU16(storage, 4, 500);
  setU16(storage, 6, 7);
  setU16(storage, 8, 0x5678);
  setU16(storage, 10, 1);
  setU16(storage, 12, 3);
  setU16(storage, 14, 0x1234);
  setU16(storage, 16, 4);
  assert.deepEqual(decodeBinaryFrame(storage), {
    kind: "storage",
    byteLength: BINARY_FRAME_LEN,
    storage: {
      shotCount: 500,
      pending: 7,
      uploadShotId: 0x12345678,
      requested: true,
      dropped: 3,
      retryAttempts: 4,
    },
  });

  const storedShot = frame29(4);
  setU16(storedShot, 4, 222);
  setU16(storedShot, 6, 0x5678);
  setI16(storedShot, 8, 1000);
  setI16(storedShot, 10, -2000);
  setI16(storedShot, 12, 500);
  setU16(storedShot, 14, 300);
  setI16(storedShot, 16, 100);
  setI16(storedShot, 18, -250);
  setI16(storedShot, 20, 0);
  setU16(storedShot, 22, 40);
  setU16(storedShot, 24, 60);
  setU16(storedShot, 26, 0x1234);
  assert.equal(decodeBinaryFrame(storedShot).shot.shotId, 0x12345678);
  assert.equal(decodeBinaryFrame(storedShot).shot.stored, true);

  const traceStatus = frame29(7);
  setU16(traceStatus, 4, 0xdef0);
  setU16(traceStatus, 6, 0x9abc);
  traceStatus[8] = 2;
  assert.deepEqual(decodeBinaryFrame(traceStatus), {
    kind: "trace-status",
    byteLength: BINARY_FRAME_LEN,
    traceStatus: {
      shotId: 0x9abcdef0,
      status: 2,
    },
  });

  const traceChunk = frame29(6);
  setU16(traceChunk, 4, 0xbeef);
  traceChunk[6] = 0;
  traceChunk[7] = 3;
  traceChunk[8] = 5;
  traceChunk.set([9, 8, 7, 6, 5], 9);
  traceChunk[28] = 7;
  assert.deepEqual(decodeBinaryFrame(traceChunk), {
    kind: "trace",
    byteLength: BINARY_FRAME_LEN,
    trace: {
      shotId: 0xbeef,
      chunkIndex: 0,
      totalChunks: 3,
      pointStride: 7,
      payload: [9, 8, 7, 6, 5],
    },
  });
});

test("malformed or unknown binary input is rejected without becoming a live sample", () => {
  assert.doesNotThrow(() => decodeBinaryFrame(new Uint8Array([0x4f, 0x46, 2])));
  assert.equal(decodeBinaryFrame(new Uint8Array([0x4f, 0x46, 2])), null);
  assert.doesNotThrow(() => decodeBinaryFrame(new Uint8Array(BINARY_FRAME_LEN)));
  assert.equal(decodeBinaryFrame(new Uint8Array(BINARY_FRAME_LEN)), null);

  const unknown = frame29(99);
  assert.doesNotThrow(() => decodeBinaryFrame(unknown));
  assert.equal(decodeBinaryFrame(unknown), null);
  assert.equal(parseBinaryFrame(unknown), null);
});

test("live and trace-status decoders reject unsupported versions at notification offsets", () => {
  for (const protocol of [0, 3, 255]) {
    for (const type of [1, 2, 3, 4, 5, 6, 7, 99]) {
      const bytes = frame29(type); bytes[2] = protocol;
      const packet = new Uint8Array(49); packet.set(bytes, 20);
      assert.equal(decodeBinaryFrame(packet, 20), null);
      assert.equal(parseBinaryFrame(packet, 20), null);
      assert.equal(parseBinaryTraceStatusFrame(packet, 20), null);
    }
  }
  for (const protocol of [1, 2]) {
    const status = frame29(7); status[2] = protocol; status[8] = 2;
    assert.equal(decodeBinaryFrame(status).traceStatus.shotId, 0);
  }
});

test("quaternionToEulerDeg normalizes inputs and decodes cardinal rotations", () => {
  const identity = quaternionToEulerDeg({ qw: 2, qx: 0, qy: 0, qz: 0 });
  assert.equal(identity.roll, 0);
  assert.equal(identity.pitch, 0);
  assert.equal(identity.yaw, 0);

  const halfSqrt = Math.SQRT1_2;
  const yaw90 = quaternionToEulerDeg({ qw: halfSqrt, qx: 0, qy: 0, qz: halfSqrt });
  assert.equal(Math.round(yaw90.roll), 0);
  assert.equal(Math.round(yaw90.pitch), 0);
  assert.equal(Math.round(yaw90.yaw), 90);
});
