/**
 * Smoke test: LoD2 mesh generation + STL export without a browser.
 * Run: npx tsx scripts/smoke-export.ts
 */
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { resolveHeights, projectBuilding, createBuildingMesh } from '../src/mesh/lod2';
import { exportStl } from '../src/export/stl';
import type { BuildingFeature, RoofShape } from '../src/types';

const origin = { lng: 21.01, lat: 52.23 };

function squareBuilding(id: string, shape: RoofShape): BuildingFeature {
  return {
    id,
    outer: [
      [21.0100, 52.2300],
      [21.0104, 52.2300],
      [21.0104, 52.2303],
      [21.0100, 52.2303],
    ],
    holes: [],
    tags: {
      height: 15,
      roofHeight: 4,
      roofShape: shape,
      levels: 4,
    },
  };
}

const shapes: RoofShape[] = ['flat', 'gabled', 'hipped', 'pyramidal', 'skillion', 'dome'];

for (const shape of shapes) {
  const h = resolveHeights({ roofShape: shape, height: 12, roofHeight: 3 });
  if (shape !== 'flat' && h.roofHeight <= 0) throw new Error(`roof height for ${shape}`);
  const b = squareBuilding(`t-${shape}`, shape);
  const projected = projectBuilding(b, origin);
  if (!projected) throw new Error(`project ${shape}`);
  const mesh = createBuildingMesh(projected);
  const count = mesh.geometry.getAttribute('position')?.count ?? 0;
  if (count < 9) throw new Error(`too few verts for ${shape}: ${count}`);
  console.log(`ok mesh ${shape}: ${count} verts`);
}

const buildings = shapes.map((s) => squareBuilding(`e-${s}`, s));
const { blob, count, filename } = exportStl(
  buildings,
  { west: 21.0099, south: 52.2299, east: 21.0105, north: 52.2304 },
  { metersToMm: 1, basePlateMm: 2, binary: true },
);

if (count !== buildings.length) throw new Error(`export count ${count}`);
if (blob.size < 100) throw new Error(`stl too small: ${blob.size}`);
console.log(`ok stl ${filename} (${blob.size} bytes, ${count} buildings)`);

// ensure exporter still works on empty-ish scene edge via THREE directly
const scene = new THREE.Scene();
scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
const raw = new STLExporter().parse(scene, { binary: true });
console.log(`ok raw exporter ${raw instanceof DataView ? raw.byteLength : String(raw).length}`);
console.log('SMOKE OK');
