/**
 * Cesium Quantized Mesh 1.0 Binary Specification Encoder & Decoder
 * Includes Extension Header ID 1: Oct-Encoded Per-Vertex Normals (96-bit float3 -> 16-bit uint2)
 */

export interface QuantizedMeshHeader {
  centerX: number;
  centerY: number;
  centerZ: number;
  minimumHeight: number;
  maximumHeight: number;
  boundingSphereCenterX: number;
  boundingSphereCenterY: number;
  boundingSphereCenterZ: number;
  boundingSphereRadius: number;
  horizonOcclusionPointX: number;
  horizonOcclusionPointY: number;
  horizonOcclusionPointZ: number;
}

export interface DecodedQuantizedMesh {
  header: QuantizedMeshHeader;
  vertexCount: number;
  triangleCount: number;
  byteLength: number;
  hasOctNormals: boolean;
  u: Uint16Array;
  v: Uint16Array;
  height: Uint16Array;
  indices: Uint16Array;
  westIndices: Uint16Array;
  southIndices: Uint16Array;
  eastIndices: Uint16Array;
  northIndices: Uint16Array;
  /** Decoded unit normal vectors (Nx, Ny, Nz) per vertex */
  normals: Float32Array;
  /** Raw oct-encoded pairs (ex, ey) in 0..255 */
  octNormalsRaw: Uint8Array;
  boundsDeg: { west: number; south: number; east: number; north: number };
}

const MOON_RADIUS_M = 1737400.0;

function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

function selenographicToMCMFArray(lonDeg: number, latDeg: number, hM: number): [number, number, number] {
  const lat = degToRad(latDeg);
  const lon = degToRad(lonDeg);
  const r = MOON_RADIUS_M + hM;
  return [
    r * Math.cos(lat) * Math.cos(lon),
    r * Math.cos(lat) * Math.sin(lon),
    r * Math.sin(lat),
  ];
}

/** Deterministic lunar crater & ridge elevation model (meters) around a site */
export function lunarElevationSampleM(lonDeg: number, latDeg: number, baseElevationM: number): number {
  const la = degToRad(latDeg);
  const lo = degToRad(lonDeg);
  const ridge = Math.sin(la * 42 + lo * 18) * 340 + Math.cos(lo * 37 - la * 29) * 260;
  const craterHarmonic = Math.sin(la * 110) * Math.cos(lo * 110) * 185;
  const micro = Math.sin(la * 240 + lo * 210) * 55;
  return baseElevationM + ridge + craterHarmonic + micro;
}

/** Octahedral encoding of a unit normal vector into 2 unsigned 8-bit integers */
export function octEncode(nx: number, ny: number, nz: number): [number, number] {
  const l1 = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) || 1;
  let ox = nx / l1;
  let oy = ny / l1;
  if (nz < 0) {
    const prevX = ox;
    const prevY = oy;
    ox = (1 - Math.abs(prevY)) * (prevX >= 0 ? 1 : -1);
    oy = (1 - Math.abs(prevX)) * (prevY >= 0 ? 1 : -1);
  }
  const ex = Math.max(0, Math.min(255, Math.round((ox * 0.5 + 0.5) * 255)));
  const ey = Math.max(0, Math.min(255, Math.round((oy * 0.5 + 0.5) * 255)));
  return [ex, ey];
}

/** Octahedral decoding from 2 unsigned 8-bit integers back to unit normal (Nx, Ny, Nz) */
export function octDecode(ex: number, ey: number): [number, number, number] {
  let x = (ex / 255) * 2 - 1;
  let y = (ey / 255) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * (oldX >= 0 ? 1 : -1);
    y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1);
  }
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/** ZigZag encode signed delta integer to unsigned 16-bit */
function zigZagEncode(n: number): number {
  return (n << 1) ^ (n >> 31);
}

function zigZagDecode(n: number): number {
  return (n >>> 1) ^ -(n & 1);
}

/**
 * Generates a real Quantized Mesh 1.0 binary buffer for a lunar landing site patch,
 * including Extension ID 1 (oct-encoded vertex normals).
 */
export function encodeLunarQuantizedMeshTile(
  centerLonDeg: number,
  centerLatDeg: number,
  baseElevationM: number,
  halfSpanDeg = 2.4,
  gridRes = 24
): ArrayBuffer {
  const west = centerLonDeg - halfSpanDeg;
  const east = centerLonDeg + halfSpanDeg;
  const south = Math.max(-89.95, centerLatDeg - halfSpanDeg);
  const north = Math.min(89.95, centerLatDeg + halfSpanDeg);

  const cols = gridRes + 1;
  const rows = gridRes + 1;
  const vertexCount = cols * rows;

  const heightsM = new Float64Array(vertexCount);
  const lons = new Float64Array(vertexCount);
  const lats = new Float64Array(vertexCount);

  let minH = Infinity;
  let maxH = -Infinity;

  for (let r = 0; r < rows; r++) {
    const tLat = r / gridRes;
    const lat = south + tLat * (north - south);
    for (let c = 0; c < cols; c++) {
      const tLon = c / gridRes;
      const lon = west + tLon * (east - west);
      const idx = r * cols + c;
      lons[idx] = lon;
      lats[idx] = lat;
      const h = lunarElevationSampleM(lon, lat, baseElevationM);
      heightsM[idx] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  if (maxH - minH < 1) maxH = minH + 1;

  // Quantize to 0..32767
  const uArr = new Uint16Array(vertexCount);
  const vArr = new Uint16Array(vertexCount);
  const hArr = new Uint16Array(vertexCount);

  for (let i = 0; i < vertexCount; i++) {
    uArr[i] = Math.floor(32767 * ((lons[i] - west) / (east - west)));
    vArr[i] = Math.floor(32767 * ((lats[i] - south) / (north - south)));
    hArr[i] = Math.floor(32767 * ((heightsM[i] - minH) / (maxH - minH)));
  }

  // Triangle indices
  const triangleCount = gridRes * gridRes * 2;
  const indices = new Uint16Array(triangleCount * 3);
  let ptr = 0;
  for (let r = 0; r < gridRes; r++) {
    for (let c = 0; c < gridRes; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      indices[ptr++] = a;
      indices[ptr++] = b;
      indices[ptr++] = d;
      indices[ptr++] = b;
      indices[ptr++] = e;
      indices[ptr++] = d;
    }
  }

  // Compute vertex normals in MCMF space & oct-encode (Extension ID 1)
  const octBytes = new Uint8Array(vertexCount * 2);
  const epsDeg = (east - west) / gridRes;
  for (let i = 0; i < vertexCount; i++) {
    const lon = lons[i];
    const lat = lats[i];
    const hE = lunarElevationSampleM(lon + epsDeg * 0.5, lat, baseElevationM);
    const hW = lunarElevationSampleM(lon - epsDeg * 0.5, lat, baseElevationM);
    const hN = lunarElevationSampleM(lon, lat + epsDeg * 0.5, baseElevationM);
    const hS = lunarElevationSampleM(lon, lat - epsDeg * 0.5, baseElevationM);

    const p0 = selenographicToMCMFArray(lon, lat, heightsM[i]);
    const len = Math.hypot(p0[0], p0[1], p0[2]) || 1;
    // Surface radial normal perturbed by finite-difference DEM gradient
    const dx = (hE - hW) / (epsDeg * 30323);
    const dy = (hN - hS) / (epsDeg * 30323);
    const nx = p0[0] / len - dx * 0.65;
    const ny = p0[1] / len - dy * 0.65;
    const nz = p0[2] / len;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const [ex, ey] = octEncode(nx / nLen, ny / nLen, nz / nLen);
    octBytes[i * 2] = ex;
    octBytes[i * 2 + 1] = ey;
  }

  // Edge indices
  const westEdge = new Uint16Array(rows);
  const eastEdge = new Uint16Array(rows);
  const southEdge = new Uint16Array(cols);
  const northEdge = new Uint16Array(cols);
  for (let r = 0; r < rows; r++) {
    westEdge[r] = r * cols;
    eastEdge[r] = r * cols + (cols - 1);
  }
  for (let c = 0; c < cols; c++) {
    southEdge[c] = c;
    northEdge[c] = (rows - 1) * cols + c;
  }

  // Delta + ZigZag encode u, v, height
  const uEnc = new Uint16Array(vertexCount);
  const vEnc = new Uint16Array(vertexCount);
  const hEnc = new Uint16Array(vertexCount);
  let prevU = 0;
  let prevV = 0;
  let prevH = 0;
  for (let i = 0; i < vertexCount; i++) {
    uEnc[i] = zigZagEncode(uArr[i] - prevU);
    vEnc[i] = zigZagEncode(vArr[i] - prevV);
    hEnc[i] = zigZagEncode(hArr[i] - prevH);
    prevU = uArr[i];
    prevV = vArr[i];
    prevH = hArr[i];
  }

  // High-water-mark encode indices
  const idxEnc = new Uint16Array(indices.length);
  let highWaterMark = 0;
  for (let i = 0; i < indices.length; i++) {
    const code = indices[i];
    idxEnc[i] = highWaterMark - code;
    if (code === highWaterMark) highWaterMark++;
  }

  // Standard Quantized Mesh header = 88 bytes (center xyz 24 + min/max 16 + sphere xyzr 32 + horizon xyz 24? Wait:
  // 3+2+3+1+3 = 12 Float64s = 96 bytes, or core 52-byte tile center + bounds + sphere/horizon).
  // We encode the full 11*8 = 88 bytes standard Quantized Mesh header (including 52-byte core center/bounds).
  const center = selenographicToMCMFArray(centerLonDeg, centerLatDeg, (minH + maxH) * 0.5);
  const corner = selenographicToMCMFArray(east, north, maxH);
  const boundRadius = Math.hypot(corner[0] - center[0], corner[1] - center[1], corner[2] - center[2]);

  const headerBytes = 88;
  const vertexSectionBytes = 4 + vertexCount * 2 * 3;
  // align indices to 2-byte boundary (already even)
  const indexSectionBytes = 4 + indices.length * 2;
  const edgeSectionBytes = 4 + westEdge.length * 2 + 4 + southEdge.length * 2 + 4 + eastEdge.length * 2 + 4 + northEdge.length * 2;
  const extSectionBytes = 1 + 4 + octBytes.byteLength;

  const totalBytes = headerBytes + vertexSectionBytes + indexSectionBytes + edgeSectionBytes + extSectionBytes;
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  let offset = 0;

  // Header
  const writeF64 = (val: number) => {
    view.setFloat64(offset, val, true);
    offset += 8;
  };
  writeF64(center[0]);
  writeF64(center[1]);
  writeF64(center[2]);
  view.setFloat32(offset, minH, true);
  offset += 4;
  view.setFloat32(offset, maxH, true);
  offset += 4;
  writeF64(center[0]);
  writeF64(center[1]);
  writeF64(center[2]);
  writeF64(boundRadius);
  writeF64(center[0] * 1.01);
  writeF64(center[1] * 1.01);
  writeF64(center[2] * 1.01);

  // VertexData
  view.setUint32(offset, vertexCount, true);
  offset += 4;
  for (let i = 0; i < vertexCount; i++) {
    view.setUint16(offset, uEnc[i], true);
    offset += 2;
  }
  for (let i = 0; i < vertexCount; i++) {
    view.setUint16(offset, vEnc[i], true);
    offset += 2;
  }
  for (let i = 0; i < vertexCount; i++) {
    view.setUint16(offset, hEnc[i], true);
    offset += 2;
  }

  // IndexData16
  view.setUint32(offset, triangleCount, true);
  offset += 4;
  for (let i = 0; i < idxEnc.length; i++) {
    view.setUint16(offset, idxEnc[i], true);
    offset += 2;
  }

  // EdgeIndices16
  const writeEdge = (arr: Uint16Array) => {
    view.setUint32(offset, arr.length, true);
    offset += 4;
    for (let i = 0; i < arr.length; i++) {
      view.setUint16(offset, arr[i], true);
      offset += 2;
    }
  };
  writeEdge(westEdge);
  writeEdge(southEdge);
  writeEdge(eastEdge);
  writeEdge(northEdge);

  // Extension Header ID: 1 (Oct-Encoded Per-Vertex Normals)
  view.setUint8(offset, 1);
  offset += 1;
  view.setUint32(offset, octBytes.byteLength, true);
  offset += 4;
  new Uint8Array(buffer, offset, octBytes.byteLength).set(octBytes);

  return buffer;
}

/**
 * Decodes a Cesium Quantized Mesh 1.0 binary ArrayBuffer including Extension ID 1 oct-encoded normals.
 */
export function parseQuantizedMeshTile(
  buffer: ArrayBuffer,
  boundsDeg: { west: number; south: number; east: number; north: number }
): DecodedQuantizedMesh {
  const view = new DataView(buffer);
  let offset = 0;

  const readF64 = () => {
    const val = view.getFloat64(offset, true);
    offset += 8;
    return val;
  };

  const centerX = readF64();
  const centerY = readF64();
  const centerZ = readF64();
  const minimumHeight = view.getFloat32(offset, true);
  offset += 4;
  const maximumHeight = view.getFloat32(offset, true);
  offset += 4;
  const boundingSphereCenterX = readF64();
  const boundingSphereCenterY = readF64();
  const boundingSphereCenterZ = readF64();
  const boundingSphereRadius = readF64();
  const horizonOcclusionPointX = readF64();
  const horizonOcclusionPointY = readF64();
  const horizonOcclusionPointZ = readF64();

  const header: QuantizedMeshHeader = {
    centerX,
    centerY,
    centerZ,
    minimumHeight,
    maximumHeight,
    boundingSphereCenterX,
    boundingSphereCenterY,
    boundingSphereCenterZ,
    boundingSphereRadius,
    horizonOcclusionPointX,
    horizonOcclusionPointY,
    horizonOcclusionPointZ,
  };

  const vertexCount = view.getUint32(offset, true);
  offset += 4;

  const u = new Uint16Array(vertexCount);
  const v = new Uint16Array(vertexCount);
  const height = new Uint16Array(vertexCount);

  let uAcc = 0;
  for (let i = 0; i < vertexCount; i++) {
    uAcc += zigZagDecode(view.getUint16(offset, true));
    u[i] = uAcc;
    offset += 2;
  }
  let vAcc = 0;
  for (let i = 0; i < vertexCount; i++) {
    vAcc += zigZagDecode(view.getUint16(offset, true));
    v[i] = vAcc;
    offset += 2;
  }
  let hAcc = 0;
  for (let i = 0; i < vertexCount; i++) {
    hAcc += zigZagDecode(view.getUint16(offset, true));
    height[i] = hAcc;
    offset += 2;
  }

  const triangleCount = view.getUint32(offset, true);
  offset += 4;
  const indices = new Uint16Array(triangleCount * 3);
  let highWaterMark = 0;
  for (let i = 0; i < indices.length; i++) {
    const code = view.getUint16(offset, true);
    offset += 2;
    const idx = highWaterMark - code;
    indices[i] = idx;
    if (code === 0) highWaterMark++;
  }

  const readEdge = () => {
    const count = view.getUint32(offset, true);
    offset += 4;
    const arr = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = view.getUint16(offset, true);
      offset += 2;
    }
    return arr;
  };

  const westIndices = readEdge();
  const southIndices = readEdge();
  const eastIndices = readEdge();
  const northIndices = readEdge();

  const normals = new Float32Array(vertexCount * 3);
  let octNormalsRaw = new Uint8Array(0);
  let hasOctNormals = false;

  while (offset + 5 <= buffer.byteLength) {
    const extId = view.getUint8(offset);
    offset += 1;
    const extLen = view.getUint32(offset, true);
    offset += 4;

    if (extId === 1 && extLen >= vertexCount * 2) {
      hasOctNormals = true;
      octNormalsRaw = new Uint8Array(buffer.slice(offset, offset + vertexCount * 2));
      for (let i = 0; i < vertexCount; i++) {
        const [nx, ny, nz] = octDecode(octNormalsRaw[i * 2], octNormalsRaw[i * 2 + 1]);
        normals[i * 3] = nx;
        normals[i * 3 + 1] = ny;
        normals[i * 3 + 2] = nz;
      }
    }
    offset += extLen;
  }

  return {
    header,
    vertexCount,
    triangleCount,
    byteLength: buffer.byteLength,
    hasOctNormals,
    u,
    v,
    height,
    indices,
    westIndices,
    southIndices,
    eastIndices,
    northIndices,
    normals,
    octNormalsRaw,
    boundsDeg,
  };
}
