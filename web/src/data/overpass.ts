import type { BBox, BuildingFeature, BuildingTags, LngLat, RoofShape } from '../types';
import { closeRingLngLat } from '../geo/projection';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

type OsmNode = { type: 'node'; id: number; lat: number; lon: number };
type OsmWay = {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
};
type OsmRelation = {
  type: 'relation';
  id: number;
  members: { type: string; ref: number; role: string }[];
  tags?: Record<string, string>;
};
type OsmElement = OsmNode | OsmWay | OsmRelation;

function parseLengthMeters(raw?: string): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().toLowerCase().replace(',', '.');
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*(m|meter|meters|ft|feet|'|″|")?$/);
  if (!match) {
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  const value = Number.parseFloat(match[1]);
  const unit = match[2];
  if (unit === 'ft' || unit === 'feet' || unit === "'" || unit === '"' || unit === '″') {
    return value * 0.3048;
  }
  return value;
}

function parseRoofShape(raw?: string): RoofShape | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  const allowed: RoofShape[] = [
    'flat',
    'gabled',
    'hipped',
    'pyramidal',
    'skillion',
    'dome',
    'round',
    'gambrel',
    'mansard',
    'onion',
  ];
  return allowed.includes(v as RoofShape) ? (v as RoofShape) : undefined;
}

function parseTags(tags: Record<string, string> = {}): BuildingTags {
  const levels = tags['building:levels'] ? Number.parseFloat(tags['building:levels']) : undefined;
  const minLevel = tags['building:min_level']
    ? Number.parseFloat(tags['building:min_level'])
    : undefined;
  const roofLevels = tags['roof:levels'] ? Number.parseFloat(tags['roof:levels']) : undefined;
  const roofOrientation =
    tags['roof:orientation'] === 'along' || tags['roof:orientation'] === 'across'
      ? tags['roof:orientation']
      : undefined;
  const roofDirection = tags['roof:direction']
    ? Number.parseFloat(tags['roof:direction'])
    : undefined;
  const roofAngle = tags['roof:angle'] ? Number.parseFloat(tags['roof:angle']) : undefined;

  return {
    height: parseLengthMeters(tags.height),
    minHeight: parseLengthMeters(tags.min_height),
    levels: Number.isFinite(levels) ? levels : undefined,
    minLevel: Number.isFinite(minLevel) ? minLevel : undefined,
    roofHeight: parseLengthMeters(tags['roof:height']),
    roofLevels: Number.isFinite(roofLevels) ? roofLevels : undefined,
    roofShape: parseRoofShape(tags['roof:shape']),
    roofOrientation,
    roofDirection: Number.isFinite(roofDirection) ? roofDirection : undefined,
    roofAngle: Number.isFinite(roofAngle) ? roofAngle : undefined,
    name: tags.name,
    colour: tags['building:colour'] || tags.colour,
  };
}

function wayToRing(way: OsmWay, nodes: Map<number, OsmNode>): LngLat[] | null {
  const ring: LngLat[] = [];
  for (const id of way.nodes) {
    const n = nodes.get(id);
    if (!n) return null;
    ring.push([n.lon, n.lat]);
  }
  const closed = closeRingLngLat(ring);
  return closed.length >= 3 ? closed : null;
}

export function parseOsmBuildings(elements: OsmElement[]): BuildingFeature[] {
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations: OsmRelation[] = [];

  for (const el of elements) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way') ways.set(el.id, el);
    else if (el.type === 'relation') relations.push(el);
  }

  const usedWays = new Set<number>();
  const buildings: BuildingFeature[] = [];

  for (const rel of relations) {
    if (!rel.tags?.building && rel.tags?.type !== 'multipolygon') continue;
    if (!rel.tags?.building && !rel.tags?.['building:part']) continue;

    const outers: LngLat[][] = [];
    const inners: LngLat[][] = [];
    for (const m of rel.members) {
      if (m.type !== 'way') continue;
      const way = ways.get(m.ref);
      if (!way) continue;
      const ring = wayToRing(way, nodes);
      if (!ring) continue;
      usedWays.add(way.id);
      if (m.role === 'inner') inners.push(ring);
      else outers.push(ring);
    }
    if (outers.length === 0) continue;
    // one feature per outer, share tags; attach all inners (approx)
    for (let i = 0; i < outers.length; i++) {
      buildings.push({
        id: `r${rel.id}-${i}`,
        outer: outers[i],
        holes: i === 0 ? inners : [],
        tags: parseTags(rel.tags),
      });
    }
  }

  for (const way of ways.values()) {
    if (usedWays.has(way.id)) continue;
    if (!way.tags?.building && !way.tags?.['building:part']) continue;
    const ring = wayToRing(way, nodes);
    if (!ring) continue;
    buildings.push({
      id: `w${way.id}`,
      outer: ring,
      holes: [],
      tags: parseTags(way.tags),
    });
  }

  return buildings;
}

export async function fetchBuildings(bbox: BBox, signal?: AbortSignal): Promise<BuildingFeature[]> {
  const { south, west, north, east } = bbox;
  const query = `
[out:json][timeout:60];
(
  way["building"](${south},${west},${north},${east});
  relation["building"](${south},${west},${north},${east});
  way["building:part"](${south},${west},${north},${east});
  relation["building:part"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;
`.trim();

  let lastError: unknown;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: query,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const data = (await res.json()) as { elements: OsmElement[] };
      return parseOsmBuildings(data.elements ?? []);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Nie udało się pobrać danych OSM');
}
