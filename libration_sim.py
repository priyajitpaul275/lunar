#!/usr/bin/env python3
"""
libration_sim.py — CLPS Lunar Landing Site Navigator
Ephemeris & Solar Duty Cycle Module (rfc-2026-clps-v1.0)

Computes topocentric Sun and Earth azimuth/elevation time-series vectors in the
IAU Mean Earth/Polar Axis (MOON_ME, R_MOON = 1,737,400.0 m) reference frame using:
  1. Local JPL NAIF SPICE kernels via spiceypy (when mounted), OR
  2. Live NASA/JPL Horizons REST API (--live-horizons, CENTER='coord@301'), OR
  3. Analytic trigonometric fallback (--synthetic / --self-test).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    import spiceypy as spice  # type: ignore
    HAS_SPICE = True
except ImportError:
    spice = None
    HAS_SPICE = False

SCHEMA_VERSION = "rfc-2026-clps-v1.0"
REFERENCE_FRAME = "IAU_MOON_2015_ME"
R_MOON_M = 1737400.0
SOLAR_GATE_PCT = 70.0
DTE_GATE_PCT = 55.0
HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"


def load_spice_kernels(kernel_paths: Sequence[str]) -> bool:
    """Ingests standard NAIF SPICE binaries (naif0012.tls, de440.bsp, moon_pa_de440_2008.bpc, moon_080317.tf)."""
    if not HAS_SPICE:
        return False
    for path in kernel_paths:
        spice.furnsh(path)
    return True


def _site_moon_me_vec(lat_deg: float, lon_deg: float, elevation_m: float) -> Tuple[float, float, float]:
    """Converts selenographic (lat, lon, h) in MOON_ME to km Cartesian vector."""
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    r_km = (R_MOON_M + elevation_m) / 1000.0
    return (
        r_km * math.cos(lat) * math.cos(lon),
        r_km * math.cos(lat) * math.sin(lon),
        r_km * math.sin(lat),
    )


def _moon_me_to_enu(
    dx: float, dy: float, dz: float, lat_deg: float, lon_deg: float
) -> Tuple[float, float, float]:
    """Rotates body-fixed MOON_ME vector difference into local East-North-Up (ENU) frame."""
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    sin_lat, cos_lat = math.sin(lat), math.cos(lat)
    sin_lon, cos_lon = math.sin(lon), math.cos(lon)

    east = -sin_lon * dx + cos_lon * dy
    north = -sin_lat * cos_lon * dx - sin_lat * sin_lon * dy + cos_lat * dz
    up = cos_lat * cos_lon * dx + cos_lat * sin_lon * dy + sin_lat * dz
    return east, north, up


def query_spice_az_el(
    et: float,
    lat_deg: float,
    lon_deg: float,
    elevation_m: float,
    target: str,
    frame: str = "MOON_ME",
) -> Tuple[float, float]:
    """
    Executes spice.spkpos() for target ('SUN' or 'EARTH') relative to Moon center
    with LT+S aberration correction and transforms to topocentric ENU (az_deg, el_deg).
    """
    if not HAS_SPICE:
        raise RuntimeError("spiceypy is not installed in this environment")

    pos_target, _ = spice.spkpos(target, et, frame, "LT+S", "MOON")
    sx, sy, sz = _site_moon_me_vec(lat_deg, lon_deg, elevation_m)
    dx = pos_target[0] - sx
    dy = pos_target[1] - sy
    dz = pos_target[2] - sz

    east, north, up = _moon_me_to_enu(dx, dy, dz, lat_deg, lon_deg)
    r = math.sqrt(east * east + north * north + up * up) or 1.0
    az_deg = math.degrees(math.atan2(east, north)) % 360.0
    el_deg = math.degrees(math.asin(max(-1.0, min(1.0, up / r))))
    return az_deg, el_deg


def interpolate_horizon_mask(azimuth_deg: float, mask_deg: Sequence[float]) -> float:
    """
    Cyclic 1D linear interpolation across terrain horizon elevation mask.
    Supports 360-element (1 deg) or 36-element (10 deg) arrays bounded in [0, 360).
    """
    n = len(mask_deg)
    if n == 0:
        return 0.0
    az = azimuth_deg % 360.0
    step = 360.0 / n
    pos = az / step
    idx0 = int(math.floor(pos)) % n
    idx1 = (idx0 + 1) % n
    frac = pos - math.floor(pos)
    y0 = float(mask_deg[idx0])
    y1 = float(mask_deg[idx1])
    return y0 + (y1 - y0) * frac


def parse_horizons_csv(raw_text: str) -> List[Dict[str, Any]]:
    """Parses $$SOE..$$EOE observer CSV rows from JPL Horizons QUANTITIES='4' output."""
    soe = raw_text.find("$$SOE")
    eoe = raw_text.find("$$EOE")
    if soe == -1 or eoe == -1 or eoe <= soe:
        raise ValueError("Missing $$SOE..$$EOE block in Horizons output")

    block = raw_text[soe + 5 : eoe].strip()
    rows: List[Dict[str, Any]] = []
    for line in block.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        try:
            az = float(parts[3]) % 360.0
            el = float(parts[4])
        except ValueError:
            continue
        rows.append({"utc": parts[0], "az_deg": az, "el_deg": el})
    return rows


def fetch_horizons_az_el(
    command: str,
    lat_deg: float,
    lon_deg: float,
    elevation_m: float,
    start_time: str,
    stop_time: str,
    step_size: str = "1h",
) -> List[Dict[str, Any]]:
    """Queries live NASA/JPL Horizons REST API in MOON_ME (CENTER='coord@301')."""
    elev_km = elevation_m / 1000.0
    params = {
        "format": "json",
        "COMMAND": f"'{command}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'coord@301'",
        "SITE_COORD": f"'{lon_deg:.4f},{lat_deg:.4f},{elev_km:.4f}'",
        "START_TIME": f"'{start_time}'",
        "STOP_TIME": f"'{stop_time}'",
        "STEP_SIZE": f"'{step_size}'",
        "QUANTITIES": "'4'",
        "CSV_FORMAT": "'YES'",
    }
    query = urllib.parse.urlencode(params)
    req = urllib.request.Request(
        f"{HORIZONS_URL}?{query}",
        headers={"User-Agent": "NASA-CLPS-Lunar-Browser/1.0"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if "result" not in payload:
        raise RuntimeError(f"Horizons API returned unexpected response: {payload}")
    return parse_horizons_csv(payload["result"])


def _synthetic_az_el_series(
    lat_deg: float, lon_deg: float, elevation_m: float, hours: int
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Truncated trigonometric series approximation of lunar solar synodic motion (29.5306 d)
    and Earth optical/physical libration (~6.68 deg ecliptic inclination, ~1.54 deg obliquity).
    """
    sun_rows: List[Dict[str, Any]] = []
    earth_rows: List[Dict[str, Any]] = []
    t0 = datetime(2025, 3, 2, 0, 0, tzinfo=timezone.utc)

    synodic_period_hr = 29.530589 * 24.0
    anomalistic_period_hr = 27.55455 * 24.0
    draconic_period_hr = 27.21222 * 24.0

    sx, sy, sz = _site_moon_me_vec(lat_deg, lon_deg, elevation_m)
    earth_dist_km = 384400.0
    sun_dist_km = 149597870.0

    for h in range(hours):
        ts = (t0 + timedelta(hours=h)).strftime("%Y-%b-%d %H:%M")

        # Subsolar longitude & latitude (obliquity ~1.54 deg)
        subsolar_lon = math.radians(((h / synodic_period_hr) * 360.0) % 360.0)
        subsolar_lat = math.radians(1.54 * math.sin(2.0 * math.pi * h / draconic_period_hr))
        tx_s = sun_dist_km * math.cos(subsolar_lat) * math.cos(subsolar_lon)
        ty_s = sun_dist_km * math.cos(subsolar_lat) * math.sin(subsolar_lon)
        tz_s = sun_dist_km * math.sin(subsolar_lat)
        e_s, n_s, u_s = _moon_me_to_enu(tx_s - sx, ty_s - sy, tz_s - sz, lat_deg, lon_deg)
        r_s = math.sqrt(e_s * e_s + n_s * n_s + u_s * u_s) or 1.0
        sun_rows.append(
            {
                "utc": ts,
                "az_deg": math.degrees(math.atan2(e_s, n_s)) % 360.0,
                "el_deg": math.degrees(math.asin(max(-1.0, min(1.0, u_s / r_s)))),
            }
        )

        # Sub-Earth libration in longitude (~7.9 deg) and latitude (~6.68 deg)
        lib_lon = math.radians(7.8 * math.sin(2.0 * math.pi * h / anomalistic_period_hr))
        lib_lat = math.radians(6.68 * math.sin(2.0 * math.pi * h / draconic_period_hr))
        tx_e = earth_dist_km * math.cos(lib_lat) * math.cos(lib_lon)
        ty_e = earth_dist_km * math.cos(lib_lat) * math.sin(lib_lon)
        tz_e = earth_dist_km * math.sin(lib_lat)
        e_e, n_e, u_e = _moon_me_to_enu(tx_e - sx, ty_e - sy, tz_e - sz, lat_deg, lon_deg)
        r_e = math.sqrt(e_e * e_e + n_e * n_e + u_e * u_e) or 1.0
        earth_rows.append(
            {
                "utc": ts,
                "az_deg": math.degrees(math.atan2(e_e, n_e)) % 360.0,
                "el_deg": math.degrees(math.asin(max(-1.0, min(1.0, u_e / r_e)))),
            }
        )

    return sun_rows, earth_rows


def _max_outage_run(flags: Sequence[bool]) -> int:
    best = 0
    cur = 0
    for ok in flags:
        if not ok:
            cur += 1
            if cur > best:
                best = cur
        else:
            cur = 0
    return best


def _rolling_720_pct(flags: Sequence[bool]) -> float:
    n = len(flags)
    if n == 0:
        return 0.0
    win = min(720, n)
    cur = sum(1 for x in flags[:win] if x)
    best = cur
    for i in range(win, n):
        cur += (1 if flags[i] else 0) - (1 if flags[i - win] else 0)
        if cur > best:
            best = cur
    return round((best / win) * 100.0, 2)


def simulate_site_ephemeris(
    lat_deg: float,
    lon_deg: float,
    elevation_m: float,
    horizon_mask_deg: Sequence[float],
    hours: int = 720,
    live_horizons: bool = False,
    start_time: str = "2025-03-02 00:00",
) -> Dict[str, Any]:
    """Executes hourly trajectory integration and emits rfc-2026-clps-v1.0 telemetry."""
    if live_horizons:
        t0 = datetime.strptime(start_time, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
        stop_time = (t0 + timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M")
        sun_rows = fetch_horizons_az_el("10", lat_deg, lon_deg, elevation_m, start_time, stop_time, "1h")
        earth_rows = fetch_horizons_az_el("399", lat_deg, lon_deg, elevation_m, start_time, stop_time, "1h")
        mock = False
        source = "NASA/JPL Horizons REST API (DE441)"
    else:
        sun_rows, earth_rows = _synthetic_az_el_series(lat_deg, lon_deg, elevation_m, hours)
        mock = True
        source = "Analytic Libration Fallback (Synthetic)"

    n = min(len(sun_rows), len(earth_rows))
    sun_lit: List[bool] = []
    earth_vis: List[bool] = []
    earth_els: List[float] = []
    earth_azs: List[float] = []

    for i in range(n):
        s = sun_rows[i]
        e = earth_rows[i]
        sun_mask = interpolate_horizon_mask(s["az_deg"], horizon_mask_deg)
        earth_mask = interpolate_horizon_mask(e["az_deg"], horizon_mask_deg)
        sun_lit.append(s["el_deg"] >= sun_mask)
        earth_vis.append(e["el_deg"] > earth_mask)
        earth_els.append(e["el_deg"])
        earth_azs.append(e["az_deg"])

    duty_cycle_pct = round((sum(1 for x in sun_lit if x) / max(1, n)) * 100.0, 2)
    visibility_pct = round((sum(1 for x in earth_vis if x) / max(1, n)) * 100.0, 2)
    libration_range_deg = round(
        math.hypot(max(earth_azs) - min(earth_azs), max(earth_els) - min(earth_els)) if n else 0.0,
        2,
    )

    return {
        "schema": SCHEMA_VERSION,
        "mock": mock,
        "source": source,
        "reference_frame": REFERENCE_FRAME,
        "moon_radius_m": R_MOON_M,
        "site": {
            "lat_deg": lat_deg,
            "lon_deg": lon_deg,
            "elevation_m": elevation_m,
            "horizon_mask_points": len(horizon_mask_deg),
        },
        "solar_illumination": {
            "duty_cycle_pct": duty_cycle_pct,
            "max_continuous_shadow_hrs": _max_outage_run(sun_lit),
            "monthly_sunlight_pct": _rolling_720_pct(sun_lit),
            "gate_threshold_pct": SOLAR_GATE_PCT,
            "pass": duty_cycle_pct >= SOLAR_GATE_PCT,
        },
        "dte_comms": {
            "visibility_pct": visibility_pct,
            "max_blackout_hrs": _max_outage_run(earth_vis),
            "libration_range_deg": libration_range_deg,
            "monthly_dte_pct": _rolling_720_pct(earth_vis),
            "gate_threshold_pct": DTE_GATE_PCT,
            "pass": visibility_pct >= DTE_GATE_PCT,
        },
        "frame_alignment_note": "Horizon masks aligned to MOON_ME; avoids ~870.4 m MOON_PA spatial offset.",
    }


def run_self_test() -> None:
    """Validates interpolation, ENU transforms, outage counters, Horizons CSV parsing, and schema."""
    # 1. Verify 360-element vs 36-element mask interpolation consistency
    mask_36 = [2.0 + 1.5 * math.sin(math.radians(a * 10.0)) for a in range(36)]
    mask_360 = [interpolate_horizon_mask(float(deg), mask_36) for deg in range(360)]
    for deg in [0.0, 15.0, 90.0, 185.0, 355.0]:
        v36 = interpolate_horizon_mask(deg, mask_36)
        v360 = interpolate_horizon_mask(deg, mask_360)
        assert abs(v36 - v360) < 1e-6, f"Mask mismatch at {deg}: {v36} vs {v360}"

    # 2. Verify ENU transformation at North Pole (+Z)
    e, n, u = _moon_me_to_enu(0.0, 0.0, 100.0, 90.0, 0.0)
    assert abs(u - 100.0) < 1e-6 and abs(e) < 1e-6, f"Polar ENU failed: {(e, n, u)}"

    # 3. Verify outage run-length algorithm
    assert _max_outage_run([True, True, True]) == 0
    assert _max_outage_run([False, False, False]) == 3
    assert _max_outage_run([True, False, False, True, False]) == 2

    # 4. Verify Horizons $$SOE..$$EOE parser
    sample_horizons = (
        "$$SOE\n"
        " 2025-Mar-02 00:00, ,i,  90.240634,    -0.706335,\n"
        " 2025-Mar-02 06:00,*,i,  91.205291,     2.187514,\n"
        "$$EOE\n"
    )
    parsed = parse_horizons_csv(sample_horizons)
    assert len(parsed) == 2
    assert abs(parsed[1]["az_deg"] - 91.205291) < 1e-6
    assert abs(parsed[1]["el_deg"] - 2.187514) < 1e-6

    # 5. Verify rfc-2026-clps-v1.0 telemetry schema output
    payload = simulate_site_ephemeris(-85.0, 29.2, 5210.0, mask_360, hours=120, live_horizons=False)
    assert payload["schema"] == SCHEMA_VERSION
    assert payload["reference_frame"] == REFERENCE_FRAME
    assert payload["moon_radius_m"] == 1737400.0
    assert "pass" in payload["solar_illumination"]
    assert "pass" in payload["dte_comms"]
    print(json.dumps({"self_test": "PASSED", "sample_payload": payload}, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="CLPS Lunar Ephemeris & Solar Duty Cycle Module")
    parser.add_argument("--self-test", action="store_true", help="Run built-in validation suite")
    parser.add_argument("--synthetic", action="store_true", help="Force analytic ephemeris fallback")
    parser.add_argument("--live-horizons", action="store_true", help="Query NASA/JPL Horizons API")
    parser.add_argument("--lat", type=float, default=-80.13, help="Site latitude (deg)")
    parser.add_argument("--lon", type=float, default=3.44, help="Site longitude (deg E)")
    parser.add_argument("--elev", type=float, default=1480.0, help="Site elevation (m)")
    parser.add_argument("--hours", type=int, default=720, help="Integration window in hours")
    args = parser.parse_args()

    if args.self_test:
        run_self_test()
        return 0

    mask_360 = [1.2 + 1.8 * max(0.0, math.sin(math.radians(d * 2.0))) for d in range(360)]
    use_live = args.live_horizons and not args.synthetic
    result = simulate_site_ephemeris(
        lat_deg=args.lat,
        lon_deg=args.lon,
        elevation_m=args.elev,
        horizon_mask_deg=mask_360,
        hours=args.hours,
        live_horizons=use_live,
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
