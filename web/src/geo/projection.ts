import type { BBox, LngLat, LocalPoint, Origin } from '../types';

const EARTH_RADIUS = 6378137;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Local tangent-plane projection in meters relative to origin. */
export function lngLatToLocal(lng: number, lat: number, origin: Origin): LocalPoint {
  const cosLat = Math.cos(toRad(origin.lat));
  const x = toRad(lng - origin.lng) * EARTH_RADIUS * cosLat;
  const y = toRad(lat - origin.lat) * EARTH_RADIUS;
  return { x, y };
}

export function projectRing(ring: LngLat[], origin: Origin): LocalPoint[] {
  return ring.map(([lng, lat]) => lngLatToLocal(lng, lat, origin));
}

export function bboxCenter(bbox: BBox): Origin {
  return {
    lng: (bbox.west + bbox.east) / 2,
    lat: (bbox.south + bbox.north) / 2,
  };
}

export function bboxAreaKm2(bbox: BBox): number {
  const origin = bboxCenter(bbox);
  const sw = lngLatToLocal(bbox.west, bbox.south, origin);
  const ne = lngLatToLocal(bbox.east, bbox.north, origin);
  const w = Math.abs(ne.x - sw.x);
  const h = Math.abs(ne.y - sw.y);
  return (w * h) / 1_000_000;
}

export function pointInBBox(lng: number, lat: number, bbox: BBox): boolean {
  return lng >= bbox.west && lng <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

export function ringIntersectsBBox(ring: LngLat[], bbox: BBox): boolean {
  if (ring.some(([lng, lat]) => pointInBBox(lng, lat, bbox))) return true;
  // crude: bbox corners inside ring via ray cast
  const corners: LngLat[] = [
    [bbox.west, bbox.south],
    [bbox.east, bbox.south],
    [bbox.east, bbox.north],
    [bbox.west, bbox.north],
  ];
  return corners.some((c) => pointInRing(c, ring));
}

function pointInRing(point: LngLat, ring: LngLat[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function ensureCcw(ring: LocalPoint[]): LocalPoint[] {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 0) return [...ring].reverse();
  return ring;
}

export function closeRingLngLat(ring: LngLat[]): LngLat[] {
  if (ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring;
}

export function ringLength(ring: LocalPoint[]): number {
  let len = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

export function longestEdgeIndex(ring: LocalPoint[]): number {
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  return best;
}

export function centroid(ring: LocalPoint[]): LocalPoint {
  let x = 0;
  let y = 0;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % ring.length];
    const cross = p0.x * p1.y - p1.x * p0.y;
    a += cross;
    x += (p0.x + p1.x) * cross;
    y += (p0.y + p1.y) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    const sx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
    const sy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
    return { x: sx, y: sy };
  }
  return { x: x / (6 * a), y: y / (6 * a) };
}
