import * as THREE from 'three';

/**
 * IAU 2015 Lunar Reference Frame Constants
 * Eliminates >4,640 km radial distortion introduced by Earth WGS84 ellipsoids.
 */
export const IAU2015_MOON = {
  NAME: 'IAU2015_Moon',
  MEAN_RADIUS_M: 1737400.0,
  SEMI_MAJOR_A_M: 1737400.0,
  SEMI_INTERMEDIATE_B_M: 1737400.0,
  SEMI_MINOR_C_M: 1735970.0,
  WGS84_A_M: 6378137.0,
  WGS84_F: 1 / 298.257223563,
};

/** Scene scale: 1 scene unit = 1,737.4 km (normalized unit sphere radius = 1.0) */
export const SCENE_MOON_RADIUS = 1.0;
export const METERS_TO_SCENE = SCENE_MOON_RADIUS / IAU2015_MOON.MEAN_RADIUS_M;

export interface MCMFVector {
  x: number;
  y: number;
  z: number;
}

/**
 * Converts selenographic coordinates (longitude λ, latitude φ in degrees, height h in meters)
 * to Moon-Centered Moon-Fixed (MCMF) Cartesian coordinates in meters:
 * X = (R_M + h) cos(φ) cos(λ)
 * Y = (R_M + h) cos(φ) sin(λ)
 * Z = (R_M + h) sin(φ)
 */
export function selenographicToMCMF(lonDeg: number, latDeg: number, heightM = 0): MCMFVector {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const r = IAU2015_MOON.MEAN_RADIUS_M + heightM;

  return {
    x: r * Math.cos(lat) * Math.cos(lon),
    y: r * Math.cos(lat) * Math.sin(lon),
    z: r * Math.sin(lat),
  };
}

/**
 * Triaxial ellipsoid conversion (X^2/a^2 + Y^2/b^2 + Z^2/c^2 = 1)
 */
export function selenographicToTriaxialMCMF(lonDeg: number, latDeg: number, heightM = 0): MCMFVector {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const a = IAU2015_MOON.SEMI_MAJOR_A_M;
  const b = IAU2015_MOON.SEMI_INTERMEDIATE_B_M;
  const c = IAU2015_MOON.SEMI_MINOR_C_M;

  const cosLat = Math.cos(lat);
  const sinLat = Math.sin(lat);
  const cosLon = Math.cos(lon);
  const sinLon = Math.sin(lon);

  const denom = Math.sqrt((cosLat * cosLon) ** 2 / (a * a) + (cosLat * sinLon) ** 2 / (b * b) + (sinLat * sinLat) / (c * c));
  const surfaceR = 1 / denom;
  const r = surfaceR + heightM;

  return {
    x: r * cosLat * cosLon,
    y: r * cosLat * sinLon,
    z: r * sinLat,
  };
}

/**
 * Computes radial error in kilometers if Earth WGS84 ellipsoid were erroneously applied to lunar coordinates.
 */
export function wgs84RadialErrorKm(latDeg: number): number {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const a = IAU2015_MOON.WGS84_A_M;
  const b = a * (1 - IAU2015_MOON.WGS84_F);
  const wgsR = Math.sqrt(
    ((a * a * Math.cos(lat)) ** 2 + (b * b * Math.sin(lat)) ** 2) /
      ((a * Math.cos(lat)) ** 2 + (b * Math.sin(lat)) ** 2)
  );
  return (wgsR - IAU2015_MOON.MEAN_RADIUS_M) / 1000;
}

/**
 * Maps MCMF (meters: +X = 0° lon, +Y = 90°E, +Z = North Pole)
 * into Three.js right-handed world space (+Y = North Pole, +X = 0° lon, -Z = 90°E)
 * matching Three.js SphereGeometry standard UV mapping when texture U=0.5 is 0° longitude.
 */
export function mcmfToThreeJS(mcmf: MCMFVector, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(
    mcmf.x * METERS_TO_SCENE,
    mcmf.z * METERS_TO_SCENE,
    -mcmf.y * METERS_TO_SCENE
  );
}

/**
 * Direct selenographic (lonDeg, latDeg, heightM) -> Three.js scene position.
 */
export function selenographicToThreeJS(
  lonDeg: number,
  latDeg: number,
  heightM = 0,
  out = new THREE.Vector3()
): THREE.Vector3 {
  const mcmf = selenographicToMCMF(lonDeg, latDeg, heightM);
  return mcmfToThreeJS(mcmf, out);
}

/**
 * Inverse transform: Three.js unit sphere point -> selenographic (latDeg, lonDeg).
 */
export function threeJSToSelenographic(vec: THREE.Vector3): { latDeg: number; lonDeg: number } {
  const n = vec.clone().normalize();
  const latDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(n.y, -1, 1)));
  // Since x = cos(lat)*cos(lon) and z = -cos(lat)*sin(lon):
  const lonDeg = THREE.MathUtils.radToDeg(Math.atan2(-n.z, n.x));
  return { latDeg, lonDeg };
}

/**
 * Computes unit quaternion in Three.js world space aligning local lander +Y (up)
 * with the lunar surface outward normal at (lonDeg, latDeg), then applying
 * roll/pitch/yaw attitude anomaly offsets (e.g. IM-1/IM-2 tipped touchdown).
 */
export function computeLanderQuaternion(
  lonDeg: number,
  latDeg: number,
  attitudeEulerDeg: { roll: number; pitch: number; yaw: number }
): THREE.Quaternion {
  const up = selenographicToThreeJS(lonDeg, latDeg, 0).normalize();
  // Local ENU frame basis on sphere
  const northPole = new THREE.Vector3(0, 1, 0);
  const east = new THREE.Vector3().crossVectors(northPole, up);
  if (east.lengthSq() < 1e-6) {
    east.set(1, 0, 0);
  } else {
    east.normalize();
  }
  const north = new THREE.Vector3().crossVectors(up, east).normalize();

  // Base ENU rotation matrix: X=East, Y=Up(Radial), Z=-North (right-handed)
  const enuMat = new THREE.Matrix4().makeBasis(east, up, north.clone().negate());
  const baseQuat = new THREE.Quaternion().setFromRotationMatrix(enuMat);

  // Attitude anomaly offset in local ENU frame (YXZ order: yaw around up, pitch, roll)
  const localEuler = new THREE.Euler(
    THREE.MathUtils.degToRad(attitudeEulerDeg.pitch),
    THREE.MathUtils.degToRad(attitudeEulerDeg.yaw),
    THREE.MathUtils.degToRad(attitudeEulerDeg.roll),
    'YXZ'
  );
  const offsetQuat = new THREE.Quaternion().setFromEuler(localEuler);

  return baseQuat.multiply(offsetQuat).normalize();
}

/**
 * Computes physical solar zenith angle (degrees) at a lunar coordinate given subsolar longitude/latitude.
 */
export function computeSolarZenithDeg(
  lonDeg: number,
  latDeg: number,
  subsolarLonDeg: number,
  subsolarLatDeg = 1.54 // Moon axial tilt ~1.54 deg
): number {
  const phi1 = THREE.MathUtils.degToRad(latDeg);
  const phi2 = THREE.MathUtils.degToRad(subsolarLatDeg);
  const dLon = THREE.MathUtils.degToRad(lonDeg - subsolarLonDeg);
  const cosZ = THREE.MathUtils.clamp(
    Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * Math.cos(phi2) * Math.cos(dLon),
    -1,
    1
  );
  return THREE.MathUtils.radToDeg(Math.acos(cosZ));
}
