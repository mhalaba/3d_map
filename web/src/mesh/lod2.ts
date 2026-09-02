import earcut from 'earcut';
import * as THREE from 'three';
import {
  centroid,
  ensureCcw,
  longestEdgeIndex,
  projectRing,
} from '../geo/projection';
import type {
  BuildingFeature,
  LocalPoint,
  Origin,
  ProjectedBuilding,
  RoofShape,
} from '../types';

const LEVEL_HEIGHT = 3;
const DEFAULT_HEIGHT = 10;
const DEFAULT_ROOF_HEIGHT = 3;

export function resolveHeights(tags: BuildingFeature['tags']): {
  minHeight: number;
  wallHeight: number;
  roofHeight: number;
  roofShape: RoofShape;
} {
  const roofShape: RoofShape = tags.roofShape ?? 'flat';
  const roofHeight =
    tags.roofHeight ??
    (tags.roofLevels != null ? tags.roofLevels * LEVEL_HEIGHT : roofShape === 'flat' ? 0 : DEFAULT_ROOF_HEIGHT);

  let minHeight = tags.minHeight ?? (tags.minLevel != null ? tags.minLevel * LEVEL_HEIGHT : 0);

  // If height is absolute total and roof exists, walls = height - roofHeight
  let wallHeight: number;
  if (tags.height != null && roofHeight > 0 && roofShape !== 'flat') {
    wallHeight = Math.max(minHeight + 0.5, tags.height - roofHeight);
  } else if (tags.levels != null) {
    wallHeight = minHeight + tags.levels * LEVEL_HEIGHT;
  } else if (tags.height != null) {
    wallHeight = tags.height;
  } else {
    wallHeight = DEFAULT_HEIGHT;
  }

  // Ensure roof sits on walls
  if (wallHeight <= minHeight) wallHeight = minHeight + DEFAULT_HEIGHT;

  return {
    minHeight,
    wallHeight,
    roofHeight: roofShape === 'flat' ? 0 : Math.max(0.2, roofHeight),
    roofShape,
  };
}

export function projectBuilding(b: BuildingFeature, origin: Origin): ProjectedBuilding | null {
  const outer = ensureCcw(projectRing(b.outer, origin));
  if (outer.length < 3) return null;
  const holes = b.holes
    .map((h) => ensureCcw(projectRing(h, origin)).reverse()) // holes CW relative to outer CCW for earcut
    .filter((h) => h.length >= 3);
  const heights = resolveHeights(b.tags);
  return {
    id: b.id,
    outer,
    holes,
    tags: b.tags,
    ...heights,
  };
}

function flattenPolygon(
  outer: LocalPoint[],
  holes: LocalPoint[][],
): {
  vertices: number[];
  holesIdx: number[];
} {
  const vertices: number[] = [];
  const holesIdx: number[] = [];
  for (const p of outer) vertices.push(p.x, p.y);
  let offset = outer.length;
  for (const hole of holes) {
    holesIdx.push(offset);
    for (const p of hole) vertices.push(p.x, p.y);
    offset += hole.length;
  }
  return { vertices, holesIdx };
}

function triangulate(outer: LocalPoint[], holes: LocalPoint[][]): number[] {
  const { vertices, holesIdx } = flattenPolygon(outer, holes);
  return earcut(vertices, holesIdx.length ? holesIdx : undefined, 2);
}

function pushTri(
  positions: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): void {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}

function geometryFromPositions(positions: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Walls between minHeight and wallHeight. */
function buildWalls(building: ProjectedBuilding): THREE.BufferGeometry {
  const positions: number[] = [];
  const rings = [building.outer, ...building.holes];

  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const bl = new THREE.Vector3(a.x, building.minHeight, -a.y);
      const br = new THREE.Vector3(b.x, building.minHeight, -b.y);
      const tl = new THREE.Vector3(a.x, building.wallHeight, -a.y);
      const tr = new THREE.Vector3(b.x, building.wallHeight, -b.y);
      pushTri(positions, bl, br, tr);
      pushTri(positions, bl, tr, tl);
    }
  }
  return geometryFromPositions(positions);
}

function buildFlatRoof(building: ProjectedBuilding): THREE.BufferGeometry {
  const positions: number[] = [];
  const idx = triangulate(building.outer, building.holes);
  const flat = [...building.outer, ...building.holes.flat()];
  const z = building.wallHeight;
  for (let i = 0; i < idx.length; i += 3) {
    const ia = flat[idx[i]];
    const ib = flat[idx[i + 1]];
    const ic = flat[idx[i + 2]];
    pushTri(
      positions,
      new THREE.Vector3(ia.x, z, -ia.y),
      new THREE.Vector3(ib.x, z, -ib.y),
      new THREE.Vector3(ic.x, z, -ic.y),
    );
  }
  // underside if elevated
  if (building.minHeight > 0.05) {
    for (let i = 0; i < idx.length; i += 3) {
      const ia = flat[idx[i]];
      const ib = flat[idx[i + 1]];
      const ic = flat[idx[i + 2]];
      const z0 = building.minHeight;
      pushTri(
        positions,
        new THREE.Vector3(ia.x, z0, -ia.y),
        new THREE.Vector3(ic.x, z0, -ic.y),
        new THREE.Vector3(ib.x, z0, -ib.y),
      );
    }
  }
  return geometryFromPositions(positions);
}

function ridgeAxis(building: ProjectedBuilding): { origin: LocalPoint; dir: LocalPoint; normal: LocalPoint } {
  const ring = building.outer;
  let edge = longestEdgeIndex(ring);
  if (building.tags.roofOrientation === 'across') {
    edge = (edge + 1) % ring.length;
  }
  if (building.tags.roofDirection != null) {
    const ang = ((building.tags.roofDirection % 360) * Math.PI) / 180;
    // compass degrees clockwise from north → local: x east, y north
    const dir = { x: Math.sin(ang), y: Math.cos(ang) };
    const c = centroid(ring);
    return {
      origin: c,
      dir,
      normal: { x: -dir.y, y: dir.x },
    };
  }
  const a = ring[edge];
  const b = ring[(edge + 1) % ring.length];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const normal = { x: -dir.y, y: dir.x };
  return { origin: centroid(ring), dir, normal };
}

function projectToAxis(p: LocalPoint, axis: ReturnType<typeof ridgeAxis>): { along: number; across: number } {
  const dx = p.x - axis.origin.x;
  const dy = p.y - axis.origin.y;
  return {
    along: dx * axis.dir.x + dy * axis.dir.y,
    across: dx * axis.normal.x + dy * axis.normal.y,
  };
}

function buildGabledRoof(building: ProjectedBuilding): THREE.BufferGeometry {
  const positions: number[] = [];
  const ring = building.outer;
  const axis = ridgeAxis(building);
  const comps = ring.map((p) => projectToAxis(p, axis));
  const maxAcross = Math.max(...comps.map((c) => Math.abs(c.across)), 0.01);
  const ridgeY = building.wallHeight + building.roofHeight;

  // For each edge, create roof quads toward ridge line (across=0)
  for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % ring.length];
    const c0 = comps[i];
    const c1 = comps[(i + 1) % ring.length];

    const r0 = {
      x: axis.origin.x + c0.along * axis.dir.x,
      y: axis.origin.y + c0.along * axis.dir.y,
    };
    const r1 = {
      x: axis.origin.x + c1.along * axis.dir.x,
      y: axis.origin.y + c1.along * axis.dir.y,
    };

    const v0 = new THREE.Vector3(p0.x, building.wallHeight, -p0.y);
    const v1 = new THREE.Vector3(p1.x, building.wallHeight, -p1.y);
    const vr0 = new THREE.Vector3(r0.x, ridgeY, -r0.y);
    const vr1 = new THREE.Vector3(r1.x, ridgeY, -r1.y);

    // skip edges nearly parallel to ridge where both across ~0
    if (Math.abs(c0.across) < 0.05 && Math.abs(c1.across) < 0.05) {
      // gable end fill: triangle from eaves to ridge ends already covered by side faces
      continue;
    }

    pushTri(positions, v0, v1, vr1);
    pushTri(positions, v0, vr1, vr0);
  }

  const alongVals = comps.map((c) => c.along);
  const minA = Math.min(...alongVals);
  const maxA = Math.max(...alongVals);

  // Explicit gable triangles using extreme along points
  const byAlong = [...ring.keys()].sort((i, j) => comps[i].along - comps[j].along);
  const endGroups = [
    byAlong.filter((i) => comps[i].along <= minA + 0.01),
    byAlong.filter((i) => comps[i].along >= maxA - 0.01),
  ];
  for (const group of endGroups) {
    if (group.length < 1) continue;
    const along = comps[group[0]].along;
    const ridge = {
      x: axis.origin.x + along * axis.dir.x,
      y: axis.origin.y + along * axis.dir.y,
    };
    const ridgeV = new THREE.Vector3(ridge.x, ridgeY, -ridge.y);
    // connect consecutive outer edges that have both verts near this end
    for (let i = 0; i < ring.length; i++) {
      const i0 = i;
      const i1 = (i + 1) % ring.length;
      if (Math.abs(comps[i0].along - along) > maxAcross * 0.25 + 0.5) continue;
      if (Math.abs(comps[i1].along - along) > maxAcross * 0.25 + 0.5) continue;
      const v0 = new THREE.Vector3(ring[i0].x, building.wallHeight, -ring[i0].y);
      const v1 = new THREE.Vector3(ring[i1].x, building.wallHeight, -ring[i1].y);
      pushTri(positions, v0, v1, ridgeV);
    }
  }

  void maxAcross;
  return geometryFromPositions(positions);
}

function buildPyramidalRoof(building: ProjectedBuilding): THREE.BufferGeometry {
  const positions: number[] = [];
  const c = centroid(building.outer);
  const apex = new THREE.Vector3(c.x, building.wallHeight + building.roofHeight, -c.y);
  const ring = building.outer;
  for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % ring.length];
    const v0 = new THREE.Vector3(p0.x, building.wallHeight, -p0.y);
    const v1 = new THREE.Vector3(p1.x, building.wallHeight, -p1.y);
    pushTri(positions, v0, v1, apex);
  }
  return geometryFromPositions(positions);
}

function buildHippedRoof(building: ProjectedBuilding): THREE.BufferGeometry {
  // Approximate hipped as truncated pyramid: inset ridge rectangle
  const positions: number[] = [];
  const ring = building.outer;
  const c = centroid(ring);
  const axis = ridgeAxis(building);
  const comps = ring.map((p) => projectToAxis(p, axis));
  const maxAlong = Math.max(...comps.map((c) => Math.abs(c.along)), 0.01);
  const maxAcross = Math.max(...comps.map((c) => Math.abs(c.across)), 0.01);
  const insetAlong = maxAlong * 0.35;
  const insetAcross = Math.min(maxAcross * 0.2, building.roofHeight);

  // Ridge as small rectangle around center
  const ridgeCorners = [
    {
      x: c.x + axis.dir.x * insetAlong + axis.normal.x * 0.01,
      y: c.y + axis.dir.y * insetAlong + axis.normal.y * 0.01,
    },
    {
      x: c.x - axis.dir.x * insetAlong + axis.normal.x * 0.01,
      y: c.y - axis.dir.y * insetAlong + axis.normal.y * 0.01,
    },
  ];
  const ridgeY = building.wallHeight + building.roofHeight;

  // Fall back to pyramidal if irregular
  if (ring.length > 6) return buildPyramidalRoof(building);

  for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % ring.length];
    const v0 = new THREE.Vector3(p0.x, building.wallHeight, -p0.y);
    const v1 = new THREE.Vector3(p1.x, building.wallHeight, -p1.y);
    // map to nearest ridge endpoints by along
    const a0 = comps[i].along;
    const a1 = comps[(i + 1) % ring.length].along;
    const r0 = a0 >= 0 ? ridgeCorners[0] : ridgeCorners[1];
    const r1 = a1 >= 0 ? ridgeCorners[0] : ridgeCorners[1];
    const vr0 = new THREE.Vector3(r0.x, ridgeY, -r0.y);
    const vr1 = new THREE.Vector3(r1.x, ridgeY, -r1.y);
    if (r0 === r1) {
      pushTri(positions, v0, v1, vr0);
    } else {
      pushTri(positions, v0, v1, vr1);
      pushTri(positions, v0, vr1, vr0);
    }
  }

  // Ridge cap
  const ra = new THREE.Vector3(ridgeCorners[0].x, ridgeY, -ridgeCorners[0].y);
  const rb = new THREE.Vector3(ridgeCorners[1].x, ridgeY, -ridgeCorners[1].y);
  // thin ridge - duplicate as line triangles skipped; add tiny quad via center
  const mid = new THREE.Vector3(c.x, ridgeY, -c.y);
  pushTri(positions, ra, rb, mid);

  void insetAcross;
  return geometryFromPositions(positions);
}

function buildSkillionRoof(building: ProjectedBuilding): THREE.BufferGeometry {
  const positions: number[] = [];
  const ring = building.outer;
  const axis = ridgeAxis(building);
  const comps = ring.map((p) => projectToAxis(p, axis));
  const acrossVals = comps.map((c) => c.across);
  const minAcross = Math.min(...acrossVals);
  const maxAcross = Math.max(...acrossVals);
  const span = Math.max(0.01, maxAcross - minAcross);
  const high = building.wallHeight + building.roofHeight;
  const low = building.wallHeight;

  const elev = (across: number) => low + ((across - minAcross) / span) * (high - low);

  // Top surface
  const idx = triangulate(ring, []);
  for (let i = 0; i < idx.length; i += 3) {
    const ia = ring[idx[i]];
    const ib = ring[idx[i + 1]];
    const ic = ring[idx[i + 2]];
    const ca = comps[idx[i]];
    const cb = comps[idx[i + 1]];
    const cc = comps[idx[i + 2]];
    pushTri(
      positions,
      new THREE.Vector3(ia.x, elev(ca.across), -ia.y),
      new THREE.Vector3(ib.x, elev(cb.across), -ib.y),
      new THREE.Vector3(ic.x, elev(cc.across), -ic.y),
    );
  }

  // Extra wall strip on low/high difference already partly in walls; add vertical fill for slope sides
  for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % ring.length];
    const e0 = elev(comps[i].across);
    const e1 = elev(comps[(i + 1) % ring.length].across);
    const base0 = new THREE.Vector3(p0.x, building.wallHeight, -p0.y);
    const base1 = new THREE.Vector3(p1.x, building.wallHeight, -p1.y);
    const top0 = new THREE.Vector3(p0.x, e0, -p0.y);
    const top1 = new THREE.Vector3(p1.x, e1, -p1.y);
    if (Math.abs(e0 - building.wallHeight) < 0.01 && Math.abs(e1 - building.wallHeight) < 0.01) {
      continue;
    }
    pushTri(positions, base0, base1, top1);
    pushTri(positions, base0, top1, top0);
  }

  return geometryFromPositions(positions);
}

function buildDomeRoof(building: ProjectedBuilding): THREE.BufferGeometry {
  // Approximate dome as pyramid with subdivided apex rings
  const positions: number[] = [];
  const c = centroid(building.outer);
  const ring = building.outer;
  const radius =
    ring.reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0) / Math.max(ring.length, 1);
  const segments = Math.max(ring.length, 12);
  const rings = 4;
  const roofH = building.roofHeight;
  const baseY = building.wallHeight;

  const pointAt = (i: number, t: number) => {
    const ang = (i / segments) * Math.PI * 2;
    const r = radius * Math.cos((t * Math.PI) / 2);
    const y = baseY + Math.sin((t * Math.PI) / 2) * roofH;
    return new THREE.Vector3(c.x + Math.cos(ang) * r, y, -(c.y + Math.sin(ang) * r));
  };

  for (let t = 0; t < rings; t++) {
    const t0 = t / rings;
    const t1 = (t + 1) / rings;
    for (let i = 0; i < segments; i++) {
      const a = pointAt(i, t0);
      const b = pointAt(i + 1, t0);
      const d = pointAt(i, t1);
      const e = pointAt(i + 1, t1);
      if (t1 >= 1) {
        const apex = new THREE.Vector3(c.x, baseY + roofH, -c.y);
        pushTri(positions, a, b, apex);
      } else {
        pushTri(positions, a, b, e);
        pushTri(positions, a, e, d);
      }
    }
  }

  // Connect footprint to first dome ring
  for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % ring.length];
    const ang0 = Math.atan2(p0.y - c.y, p0.x - c.x);
    const ang1 = Math.atan2(p1.y - c.y, p1.x - c.x);
    const d0 = new THREE.Vector3(
      c.x + Math.cos(ang0) * radius,
      baseY,
      -(c.y + Math.sin(ang0) * radius),
    );
    const d1 = new THREE.Vector3(
      c.x + Math.cos(ang1) * radius,
      baseY,
      -(c.y + Math.sin(ang1) * radius),
    );
    const v0 = new THREE.Vector3(p0.x, baseY, -p0.y);
    const v1 = new THREE.Vector3(p1.x, baseY, -p1.y);
    pushTri(positions, v0, v1, d1);
    pushTri(positions, v0, d1, d0);
  }

  return geometryFromPositions(positions);
}

function buildRoof(building: ProjectedBuilding): THREE.BufferGeometry {
  switch (building.roofShape) {
    case 'gabled':
    case 'gambrel':
      return buildGabledRoof(building);
    case 'hipped':
    case 'mansard':
      return buildHippedRoof(building);
    case 'pyramidal':
    case 'onion':
      return buildPyramidalRoof(building);
    case 'skillion':
      return buildSkillionRoof(building);
    case 'dome':
    case 'round':
      return buildDomeRoof(building);
    case 'flat':
    default:
      return buildFlatRoof(building);
  }
}

export function buildBuildingGeometry(building: ProjectedBuilding): THREE.BufferGeometry {
  const walls = buildWalls(building);
  const roof = buildRoof(building);
  const merged = mergeGeometries([walls, roof]);
  return merged ?? walls;
}

function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const positions: number[] = [];
  for (const g of geos) {
    const attr = g.getAttribute('position');
    if (!attr) continue;
    for (let i = 0; i < attr.count; i++) {
      positions.push(attr.getX(i), attr.getY(i), attr.getZ(i));
    }
    g.dispose();
  }
  if (!positions.length) return null;
  return geometryFromPositions(positions);
}

export function buildingColor(tags: BuildingFeature['tags'], selected: boolean): THREE.Color {
  if (selected) return new THREE.Color('#e07a3d');
  if (tags.colour) {
    try {
      return new THREE.Color(tags.colour);
    } catch {
      /* ignore */
    }
  }
  return new THREE.Color('#c4b4a0');
}

export function createBuildingMesh(
  building: ProjectedBuilding,
  selected = false,
): THREE.Mesh {
  const geometry = buildBuildingGeometry(building);
  const material = new THREE.MeshStandardMaterial({
    color: buildingColor(building.tags, selected),
    roughness: 0.85,
    metalness: 0.05,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = building.id;
  mesh.userData.buildingId = building.id;
  return mesh;
}

export function createBasePlate(
  buildings: ProjectedBuilding[],
  thicknessMm: number,
  metersToMm: number,
): THREE.BufferGeometry | null {
  if (!buildings.length || thicknessMm <= 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of buildings) {
    for (const p of b.outer) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  const pad = 5; // meters
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const t = thicknessMm / metersToMm; // meters in scene before scale
  const positions: number[] = [];
  const y0 = -t;
  const y1 = 0;
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  // top
  pushTri(
    positions,
    new THREE.Vector3(corners[0].x, y1, -corners[0].y),
    new THREE.Vector3(corners[1].x, y1, -corners[1].y),
    new THREE.Vector3(corners[2].x, y1, -corners[2].y),
  );
  pushTri(
    positions,
    new THREE.Vector3(corners[0].x, y1, -corners[0].y),
    new THREE.Vector3(corners[2].x, y1, -corners[2].y),
    new THREE.Vector3(corners[3].x, y1, -corners[3].y),
  );
  // bottom
  pushTri(
    positions,
    new THREE.Vector3(corners[0].x, y0, -corners[0].y),
    new THREE.Vector3(corners[2].x, y0, -corners[2].y),
    new THREE.Vector3(corners[1].x, y0, -corners[1].y),
  );
  pushTri(
    positions,
    new THREE.Vector3(corners[0].x, y0, -corners[0].y),
    new THREE.Vector3(corners[3].x, y0, -corners[3].y),
    new THREE.Vector3(corners[2].x, y0, -corners[2].y),
  );
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const bl = new THREE.Vector3(a.x, y0, -a.y);
    const br = new THREE.Vector3(b.x, y0, -b.y);
    const tl = new THREE.Vector3(a.x, y1, -a.y);
    const tr = new THREE.Vector3(b.x, y1, -b.y);
    pushTri(positions, bl, br, tr);
    pushTri(positions, bl, tr, tl);
  }
  return geometryFromPositions(positions);
}
