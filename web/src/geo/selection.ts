import type { BBox, BuildingFeature, LngLat } from '../types';
import { ringIntersectsBBox } from '../geo/projection';

export type ScreenRect = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export function normalizeScreenRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): ScreenRect {
  return {
    minX: Math.min(ax, bx),
    maxX: Math.max(ax, bx),
    minY: Math.min(ay, by),
    maxY: Math.max(ay, by),
  };
}

export function isMeaningfulScreenRect(rect: ScreenRect, minPx = 8): boolean {
  return rect.maxX - rect.minX >= minPx && rect.maxY - rect.minY >= minPx;
}

/** Axis-aligned geographic bbox covering all four unprojected screen corners. */
export function screenRectToGeoBBox(
  unproject: (x: number, y: number) => { lng: number; lat: number },
  rect: ScreenRect,
): BBox {
  const corners = [
    unproject(rect.minX, rect.minY),
    unproject(rect.maxX, rect.minY),
    unproject(rect.maxX, rect.maxY),
    unproject(rect.minX, rect.maxY),
  ];
  return {
    west: Math.min(...corners.map((c) => c.lng)),
    east: Math.max(...corners.map((c) => c.lng)),
    south: Math.min(...corners.map((c) => c.lat)),
    north: Math.max(...corners.map((c) => c.lat)),
  };
}

function ringCentroid(ring: LngLat[]): LngLat {
  let lng = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lng += x;
    lat += y;
  }
  const n = Math.max(ring.length, 1);
  return [lng / n, lat / n];
}

/**
 * Buildings whose footprint centroid projects into the screen rectangle.
 * This matches what the user sees on a pitched / rotated map much better than
 * a 2-corner geographic bbox alone.
 */
export function filterBuildingsInScreenRect(
  buildings: BuildingFeature[],
  rect: ScreenRect,
  project: (lng: number, lat: number) => { x: number; y: number },
): BuildingFeature[] {
  const pad = 2;
  const minX = rect.minX - pad;
  const maxX = rect.maxX + pad;
  const minY = rect.minY - pad;
  const maxY = rect.maxY + pad;

  return buildings.filter((b) => {
    if (b.outer.length < 3) return false;
    const [lng, lat] = ringCentroid(b.outer);
    const p = project(lng, lat);
    if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) return true;

    // Also accept if any vertex projects into the rect (large buildings).
    return b.outer.some(([vlng, vlat]) => {
      const vp = project(vlng, vlat);
      return vp.x >= minX && vp.x <= maxX && vp.y >= minY && vp.y <= maxY;
    });
  });
}

/** Geographic fallback when screen projection is unavailable. */
export function filterBuildingsInBBox(
  buildings: BuildingFeature[],
  bbox: BBox,
): BuildingFeature[] {
  return buildings.filter((b) => ringIntersectsBBox(b.outer, bbox));
}

/** Union of screen-hit buildings and geo-bbox hits (max recall for export). */
export function resolveSelectionBuildings(
  buildings: BuildingFeature[],
  bbox: BBox,
  screenHits: BuildingFeature[],
): BuildingFeature[] {
  const byId = new Map<string, BuildingFeature>();
  for (const b of screenHits) byId.set(b.id, b);
  for (const b of filterBuildingsInBBox(buildings, bbox)) byId.set(b.id, b);
  return [...byId.values()];
}
