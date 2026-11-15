/**
 * Off-Thread CZML Telemetry & Ephemeris Web Worker
 * Handles CZML 1.0 packet unpacking, cubic Hermite polynomial position interpolation,
 * and unit quaternion SLERP math away from the main WebGL rendering thread.
 */

export interface CZMLPacket {
  id: string;
  name?: string;
  availability?: string;
  position?: {
    epoch: string;
    referenceFrame?: string;
    interpolationAlgorithm?: string;
    cartesian: number[]; // [t0, x0, y0, z0, t1, x1, y1, z1, ...]
  };
  orientation?: {
    epoch: string;
    interpolationAlgorithm?: string;
    unitQuaternion: number[]; // [t0, qx, qy, qz, qw, ...]
  };
  properties?: Record<string, unknown>;
}

export interface ParsedTrack {
  id: string;
  name: string;
  epochMs: number;
  times: Float64Array;
  positions: Float64Array; // 3 * N (MCMF meters)
  orientTimes: Float64Array;
  quaternions: Float64Array; // 4 * M (qx, qy, qz, qw)
  durationSec: number;
}

export interface SampledEntityState {
  id: string;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

const parsedTracks = new Map<string, ParsedTrack>();

function parsePackets(packets: CZMLPacket[]) {
  parsedTracks.clear();

  for (const pkt of packets) {
    if (pkt.id === 'document' || !pkt.position?.cartesian?.length) continue;

    const cart = pkt.position.cartesian;
    const count = Math.floor(cart.length / 4);
    const times = new Float64Array(count);
    const positions = new Float64Array(count * 3);

    for (let i = 0; i < count; i++) {
      times[i] = cart[i * 4];
      positions[i * 3] = cart[i * 4 + 1];
      positions[i * 3 + 1] = cart[i * 4 + 2];
      positions[i * 3 + 2] = cart[i * 4 + 3];
    }

    const qArr = pkt.orientation?.unitQuaternion ?? [];
    const qCount = Math.floor(qArr.length / 5);
    const orientTimes = new Float64Array(qCount);
    const quaternions = new Float64Array(qCount * 4);
    for (let i = 0; i < qCount; i++) {
      orientTimes[i] = qArr[i * 5];
      quaternions[i * 4] = qArr[i * 5 + 1];
      quaternions[i * 4 + 1] = qArr[i * 5 + 2];
      quaternions[i * 4 + 2] = qArr[i * 5 + 3];
      quaternions[i * 4 + 3] = qArr[i * 5 + 4];
    }

    const epochMs = Date.parse(pkt.position.epoch || '2025-03-02T00:00:00Z');
    const durationSec = count > 0 ? times[count - 1] - times[0] : 0;

    parsedTracks.set(pkt.id, {
      id: pkt.id,
      name: pkt.name || pkt.id,
      epochMs,
      times,
      positions,
      orientTimes,
      quaternions,
      durationSec,
    });
  }
}

/**
 * Cubic Hermite polynomial position interpolation using Catmull-Rom finite-difference tangents.
 */
function sampleHermitePosition(track: ParsedTrack, tSec: number): [number, number, number] {
  const { times, positions } = track;
  const n = times.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1 || tSec <= times[0]) return [positions[0], positions[1], positions[2]];
  if (tSec >= times[n - 1]) {
    const k = (n - 1) * 3;
    return [positions[k], positions[k + 1], positions[k + 2]];
  }

  // Binary search interval
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= tSec) lo = mid;
    else hi = mid;
  }

  const dt = times[hi] - times[lo] || 1;
  const u = (tSec - times[lo]) / dt;
  const u2 = u * u;
  const u3 = u2 * u;

  // Hermite basis functions
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  const iPrev = Math.max(0, lo - 1);
  const iNext = Math.min(n - 1, hi + 1);
  const dtPrev = times[hi] - times[iPrev] || dt;
  const dtNext = times[iNext] - times[lo] || dt;

  const out: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const p0 = positions[lo * 3 + axis];
    const p1 = positions[hi * 3 + axis];
    const m0 = ((positions[hi * 3 + axis] - positions[iPrev * 3 + axis]) / dtPrev) * dt;
    const m1 = ((positions[iNext * 3 + axis] - positions[lo * 3 + axis]) / dtNext) * dt;
    out[axis] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
  }
  return out;
}

/**
 * Unit Quaternion Spherical Linear Interpolation (SLERP)
 */
function sampleQuaternionSlerp(track: ParsedTrack, tSec: number): [number, number, number, number] {
  const { orientTimes, quaternions } = track;
  const n = orientTimes.length;
  if (n === 0) return [0, 0, 0, 1];
  if (n === 1 || tSec <= orientTimes[0]) {
    return [quaternions[0], quaternions[1], quaternions[2], quaternions[3]];
  }
  if (tSec >= orientTimes[n - 1]) {
    const k = (n - 1) * 4;
    return [quaternions[k], quaternions[k + 1], quaternions[k + 2], quaternions[k + 3]];
  }

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (orientTimes[mid] <= tSec) lo = mid;
    else hi = mid;
  }

  const dt = orientTimes[hi] - orientTimes[lo] || 1;
  const alpha = (tSec - orientTimes[lo]) / dt;

  let ax = quaternions[lo * 4];
  let ay = quaternions[lo * 4 + 1];
  let az = quaternions[lo * 4 + 2];
  let aw = quaternions[lo * 4 + 3];

  let bx = quaternions[hi * 4];
  let by = quaternions[hi * 4 + 1];
  let bz = quaternions[hi * 4 + 2];
  let bw = quaternions[hi * 4 + 3];

  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }

  if (dot > 0.9995) {
    const rx = ax + alpha * (bx - ax);
    const ry = ay + alpha * (by - ay);
    const rz = az + alpha * (bz - az);
    const rw = aw + alpha * (bw - aw);
    const len = Math.hypot(rx, ry, rz, rw) || 1;
    return [rx / len, ry / len, rz / len, rw / len];
  }

  const theta0 = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta0 = Math.sin(theta0);
  const theta = theta0 * alpha;
  const s0 = Math.cos(theta) - (dot * Math.sin(theta)) / sinTheta0;
  const s1 = Math.sin(theta) / sinTheta0;

  return [
    s0 * ax + s1 * bx,
    s0 * ay + s1 * by,
    s0 * az + s1 * bz,
    s0 * aw + s1 * bw,
  ];
}

self.onmessage = (event: MessageEvent) => {
  const { type, packets, progressNorm } = event.data;

  if (type === 'PARSE_CZML') {
    const t0 = performance.now();
    parsePackets(packets as CZMLPacket[]);
    const parseMs = performance.now() - t0;
    const summary = Array.from(parsedTracks.values()).map((t) => ({
      id: t.id,
      name: t.name,
      sampleCount: t.times.length,
      durationSec: t.durationSec,
    }));
    self.postMessage({ type: 'CZML_PARSED', summary, parseMs });
  } else if (type === 'SAMPLE_EPOCH') {
    const norm = Math.max(0, Math.min(1, Number(progressNorm) || 0));
    const states: SampledEntityState[] = [];

    for (const track of parsedTracks.values()) {
      const tMin = track.times[0] ?? 0;
      const tMax = track.times[track.times.length - 1] ?? 0;
      const tSec = tMin + norm * (tMax - tMin);
      const [x, y, z] = sampleHermitePosition(track, tSec);
      const [qx, qy, qz, qw] = sampleQuaternionSlerp(track, tSec);
      states.push({ id: track.id, x, y, z, qx, qy, qz, qw });
    }

    self.postMessage({ type: 'EPOCH_SAMPLED', progressNorm: norm, states });
  }
};
