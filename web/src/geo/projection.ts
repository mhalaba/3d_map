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

function segmentsIntersect(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  const orient = (p: LngLat, q: LngLat, r: LngLat) =>
    Math.sign((q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]));
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

export function ringIntersectsBBox(ring: LngLat[], bbox: BBox): boolean {
  if (ring.length < 2) return false;

  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  // Fast reject when envelopes don't overlap
  if (maxLng < bbox.west || minLng > bbox.east || maxLat < bbox.south || minLat > bbox.north) {
    return false;
  }
  // Building envelope fully inside selection
  if (
    minLng >= bbox.west &&
    maxLng <= bbox.east &&
    minLat >= bbox.south &&
    maxLat <= bbox.north
  ) {
    return true;
  }

  if (ring.some(([lng, lat]) => pointInBBox(lng, lat, bbox))) return true;

  const corners: LngLat[] = [
    [bbox.west, bbox.south],
    [bbox.east, bbox.south],
    [bbox.east, bbox.north],
    [bbox.west, bbox.north],
  ];
  if (corners.some((c) => pointInRing(c, ring))) return true;

  // Edge crossings — catches long buildings that span the selection without
  // putting a vertex inside or containing a selection corner.
  const bboxEdges: [LngLat, LngLat][] = [
    [
      [bbox.west, bbox.south],
      [bbox.east, bbox.south],
    ],
    [
      [bbox.east, bbox.south],
      [bbox.east, bbox.north],
    ],
    [
      [bbox.east, bbox.north],
      [bbox.west, bbox.north],
    ],
    [
      [bbox.west, bbox.north],
      [bbox.west, bbox.south],
    ],
  ];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    for (const [c, d] of bboxEdges) {
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
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
