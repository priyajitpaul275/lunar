/**
 * librationEngine.ts — TypeScript Ephemeris, Horizon Mask & Solar/DTE Duty Cycle Engine
 * Mirrors libration_sim.py (rfc-2026-clps-v1.0) for real-time JPL Horizons integration
 * in IAU_MOON_2015_ME (R_MOON = 1,737,400.0 m).
 */

export const LIBRATION_CONSTANTS = {
  SCHEMA_VERSION: 'rfc-2026-clps-v1.0',
  REFERENCE_FRAME: 'IAU_MOON_2015_ME',
  R_MOON_M: 1737400.0,
  MOON_PA_OFFSET_M: 870.4,
  SOLAR_GATE_PCT: 70.0,
  DTE_GATE_PCT: 55.0,
};

export interface AzElPoint {
  utc: string;
  azDeg: number;
  elDeg: number;
}

export interface EphemerisSampleRow {
  hourIndex: number;
  utc: string;
  sunAzDeg: number;
  sunElDeg: number;
  sunMaskElDeg: number;
  sunLit: boolean;
  earthAzDeg: number;
  earthElDeg: number;
  earthMaskElDeg: number;
  earthVisible: boolean;
}

export interface LibrationTelemetryPayload {
  schema: string;
  mock: boolean;
  source: string;
  reference_frame: string;
  moon_radius_m: number;
  cache?: string;
  latencyMs?: number;
  site: {
    lat_deg: number;
    lon_deg: number;
    elevation_m: number;
    horizon_mask_points: number;
  };
  horizon_mask_deg: number[];
  solar_illumination: {
    duty_cycle_pct: number;
    max_continuous_shadow_hrs: number;
    monthly_sunlight_pct: number;
    gate_threshold_pct: number;
    pass: boolean;
  };
  dte_comms: {
    visibility_pct: number;
    max_blackout_hrs: number;
    libration_range_deg: number;
    monthly_dte_pct: number;
    gate_threshold_pct: number;
    pass: boolean;
  };
  frame_alignment_note: string;
  series: EphemerisSampleRow[];
}

/**
 * Cyclic 1D linear interpolation across terrain horizon mask (360-pt 1 deg or 36-pt 10 deg).
 */
export function interpolateHorizonMask(azimuthDeg: number, maskDeg: number[]): number {
  const n = maskDeg.length;
  if (n === 0) return 0;
  const az = ((azimuthDeg % 360) + 360) % 360;
  const step = 360 / n;
  const pos = az / step;
  const idx0 = Math.floor(pos) % n;
  const idx1 = (idx0 + 1) % n;
  const frac = pos - Math.floor(pos);
  return maskDeg[idx0] + (maskDeg[idx1] - maskDeg[idx0]) * frac;
}

/**
 * Generates a realistic MOON_ME terrain horizon elevation profile (degrees) for a lunar site.
 * Polar ridge sites (Shackleton, Mons Mouton) exhibit low horizon clearances; deep crater basins
 * (Schrödinger, Malapert A crater floor) exhibit higher surrounding rim masks.
 */
export function generateSiteHorizonMask(
  latDeg: number,
  lonDeg: number,
  elevationM: number,
  resolution: 36 | 360 = 360
): number[] {
  const absLat = Math.abs(latDeg);
  // Higher elevations sit above surrounding crater rims (lower horizon obstruction)
  const baseHorizon =
    elevationM > 3500
      ? 0.4
      : elevationM < -2000
        ? 4.2
        : absLat > 78
          ? 2.1
          : 1.5;

  const mask: number[] = new Array(resolution);
  for (let i = 0; i < resolution; i++) {
    const azRad = ((i * 360) / resolution) * (Math.PI / 180);
    const phase = ((latDeg * 3.1 + lonDeg * 1.7) * Math.PI) / 180;
    const ridge1 = Math.sin(azRad * 2 + phase) * 1.35;
    const ridge2 = Math.cos(azRad * 5 - phase * 0.6) * 0.75;
    const peak = Math.max(0, Math.sin(azRad * 3 + phase * 1.4)) * (absLat > 78 ? 1.9 : 0.8);
    mask[i] = Number(Math.max(-0.5, baseHorizon + ridge1 + ridge2 + peak).toFixed(3));
  }
  return mask;
}

/**
 * Parses $$SOE..$$EOE observer CSV block returned by NASA/JPL Horizons API (QUANTITIES='4').
 */
export function parseHorizonsCsv(rawText: string): AzElPoint[] {
  const soe = rawText.indexOf('$$SOE');
  const eoe = rawText.indexOf('$$EOE');
  if (soe === -1 || eoe === -1 || eoe <= soe) {
    throw new Error('Missing $$SOE..$$EOE block in Horizons ephemeris response');
  }

  const block = rawText.slice(soe + 5, eoe).trim();
  const rows: AzElPoint[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 5) continue;
    const az = Number(parts[3]);
    const el = Number(parts[4]);
    if (!Number.isFinite(az) || !Number.isFinite(el)) continue;
    rows.push({
      utc: parts[0],
      azDeg: ((az % 360) + 360) % 360,
      elDeg: el,
    });
  }
  return rows;
}

function siteMoonMeKm(latDeg: number, lonDeg: number, elevationM: number): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const rKm = (LIBRATION_CONSTANTS.R_MOON_M + elevationM) / 1000;
  return [
    rKm * Math.cos(lat) * Math.cos(lon),
    rKm * Math.cos(lat) * Math.sin(lon),
    rKm * Math.sin(lat),
  ];
}

function moonMeToEnu(
  dx: number,
  dy: number,
  dz: number,
  latDeg: number,
  lonDeg: number
): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  const east = -sinLon * dx + cosLon * dy;
  const north = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
  const up = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;
  return [east, north, up];
}

export function generateSyntheticAzElSeries(
  latDeg: number,
  lonDeg: number,
  elevationM: number,
  hours = 720
): { sunRows: AzElPoint[]; earthRows: AzElPoint[] } {
  const sunRows: AzElPoint[] = [];
  const earthRows: AzElPoint[] = [];

  const t0Ms = Date.UTC(2025, 2, 2, 0, 0, 0);
  const synodicHr = 29.530589 * 24;
  const anomalisticHr = 27.55455 * 24;
  const draconicHr = 27.21222 * 24;

  const [sx, sy, sz] = siteMoonMeKm(latDeg, lonDeg, elevationM);
  const earthDistKm = 384400;
  const sunDistKm = 149597870;

  for (let h = 0; h < hours; h++) {
    const utc = new Date(t0Ms + h * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');

    const subsolarLon = (((h / synodicHr) * 360) % 360) * (Math.PI / 180);
    const subsolarLat = (1.54 * Math.sin((2 * Math.PI * h) / draconicHr)) * (Math.PI / 180);
    const txS = sunDistKm * Math.cos(subsolarLat) * Math.cos(subsolarLon);
    const tyS = sunDistKm * Math.cos(subsolarLat) * Math.sin(subsolarLon);
    const tzS = sunDistKm * Math.sin(subsolarLat);
    const [eS, nS, uS] = moonMeToEnu(txS - sx, tyS - sy, tzS - sz, latDeg, lonDeg);
    const rS = Math.hypot(eS, nS, uS) || 1;
    sunRows.push({
      utc,
      azDeg: (((Math.atan2(eS, nS) * 180) / Math.PI) + 360) % 360,
      elDeg: (Math.asin(Math.max(-1, Math.min(1, uS / rS))) * 180) / Math.PI,
    });

    const libLon = (7.8 * Math.sin((2 * Math.PI * h) / anomalisticHr)) * (Math.PI / 180);
    const libLat = (6.68 * Math.sin((2 * Math.PI * h) / draconicHr)) * (Math.PI / 180);
    const txE = earthDistKm * Math.cos(libLat) * Math.cos(libLon);
    const tyE = earthDistKm * Math.cos(libLat) * Math.sin(libLon);
    const tzE = earthDistKm * Math.sin(libLat);
    const [eE, nE, uE] = moonMeToEnu(txE - sx, tyE - sy, tzE - sz, latDeg, lonDeg);
    const rE = Math.hypot(eE, nE, uE) || 1;
    earthRows.push({
      utc,
      azDeg: (((Math.atan2(eE, nE) * 180) / Math.PI) + 360) % 360,
      elDeg: (Math.asin(Math.max(-1, Math.min(1, uE / rE))) * 180) / Math.PI,
    });
  }

  return { sunRows, earthRows };
}

function maxOutageRun(flags: boolean[]): number {
  let best = 0;
  let cur = 0;
  for (const ok of flags) {
    if (!ok) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

function rolling720Pct(flags: boolean[]): number {
  const n = flags.length;
  if (n === 0) return 0;
  const win = Math.min(720, n);
  let cur = 0;
  for (let i = 0; i < win; i++) if (flags[i]) cur++;
  let best = cur;
  for (let i = win; i < n; i++) {
    cur += (flags[i] ? 1 : 0) - (flags[i - win] ? 1 : 0);
    if (cur > best) best = cur;
  }
  return Number(((best / win) * 100).toFixed(2));
}

export function computeDutyCycleTelemetry(params: {
  latDeg: number;
  lonDeg: number;
  elevationM: number;
  horizonMaskDeg: number[];
  sunRows: AzElPoint[];
  earthRows: AzElPoint[];
  mock: boolean;
  source: string;
}): LibrationTelemetryPayload {
  const { latDeg, lonDeg, elevationM, horizonMaskDeg, sunRows, earthRows, mock, source } = params;
  const n = Math.min(sunRows.length, earthRows.length);

  const sunLitFlags: boolean[] = [];
  const earthVisFlags: boolean[] = [];
  const series: EphemerisSampleRow[] = [];

  let minEl = Infinity;
  let maxEl = -Infinity;
  let minAz = Infinity;
  let maxAz = -Infinity;

  for (let i = 0; i < n; i++) {
    const s = sunRows[i];
    const e = earthRows[i];
    const sMask = interpolateHorizonMask(s.azDeg, horizonMaskDeg);
    const eMask = interpolateHorizonMask(e.azDeg, horizonMaskDeg);
    const lit = s.elDeg >= sMask;
    const vis = e.elDeg > eMask;

    sunLitFlags.push(lit);
    earthVisFlags.push(vis);

    if (e.elDeg < minEl) minEl = e.elDeg;
    if (e.elDeg > maxEl) maxEl = e.elDeg;
    if (e.azDeg < minAz) minAz = e.azDeg;
    if (e.azDeg > maxAz) maxAz = e.azDeg;

    series.push({
      hourIndex: i,
      utc: s.utc,
      sunAzDeg: Number(s.azDeg.toFixed(2)),
      sunElDeg: Number(s.elDeg.toFixed(2)),
      sunMaskElDeg: Number(sMask.toFixed(2)),
      sunLit: lit,
      earthAzDeg: Number(e.azDeg.toFixed(2)),
      earthElDeg: Number(e.elDeg.toFixed(2)),
      earthMaskElDeg: Number(eMask.toFixed(2)),
      earthVisible: vis,
    });
  }

  const dutyCyclePct = Number(
    ((sunLitFlags.filter(Boolean).length / Math.max(1, n)) * 100).toFixed(2)
  );
  const visibilityPct = Number(
    ((earthVisFlags.filter(Boolean).length / Math.max(1, n)) * 100).toFixed(2)
  );
  // Wrap-safe azimuth span for libration excursion
  const rawAzSpan = n > 0 ? maxAz - minAz : 0;
  const azSpan = rawAzSpan > 180 ? 360 - rawAzSpan : rawAzSpan;
  const elSpan = n > 0 ? maxEl - minEl : 0;
  const librationRangeDeg = Number(Math.hypot(azSpan, elSpan).toFixed(2));

  return {
    schema: LIBRATION_CONSTANTS.SCHEMA_VERSION,
    mock,
    source,
    reference_frame: LIBRATION_CONSTANTS.REFERENCE_FRAME,
    moon_radius_m: LIBRATION_CONSTANTS.R_MOON_M,
    site: {
      lat_deg: latDeg,
      lon_deg: lonDeg,
      elevation_m: elevationM,
      horizon_mask_points: horizonMaskDeg.length,
    },
    horizon_mask_deg: horizonMaskDeg,
    solar_illumination: {
      duty_cycle_pct: dutyCyclePct,
      max_continuous_shadow_hrs: maxOutageRun(sunLitFlags),
      monthly_sunlight_pct: rolling720Pct(sunLitFlags),
      gate_threshold_pct: LIBRATION_CONSTANTS.SOLAR_GATE_PCT,
      pass: dutyCyclePct >= LIBRATION_CONSTANTS.SOLAR_GATE_PCT,
    },
    dte_comms: {
      visibility_pct: visibilityPct,
      max_blackout_hrs: maxOutageRun(earthVisFlags),
      libration_range_deg: librationRangeDeg,
      monthly_dte_pct: rolling720Pct(earthVisFlags),
      gate_threshold_pct: LIBRATION_CONSTANTS.DTE_GATE_PCT,
      pass: visibilityPct >= LIBRATION_CONSTANTS.DTE_GATE_PCT,
    },
    frame_alignment_note:
      'Terrain horizon masks referenced to IAU_MOON_2015_ME; eliminates ~870.4 m MOON_PA sub-Earth frame offset.',
    series,
  };
}
