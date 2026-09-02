import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { bboxCenter, ringIntersectsBBox } from '../geo/projection';
import {
  createBasePlate,
  createBuildingMesh,
  projectBuilding,
} from '../mesh/lod2';
import type { BBox, BuildingFeature, ExportOptions } from '../types';

export function filterBuildingsInBBox(
  buildings: BuildingFeature[],
  bbox: BBox,
): BuildingFeature[] {
  return buildings.filter((b) => ringIntersectsBBox(b.outer, bbox));
}

export function buildExportScene(
  buildings: BuildingFeature[],
  bbox: BBox,
  options: ExportOptions,
): { scene: THREE.Scene; count: number; origin: { lng: number; lat: number } } {
  const selected = filterBuildingsInBBox(buildings, bbox);
  const origin = bboxCenter(bbox);
  const scene = new THREE.Scene();
  const projected = selected
    .map((b) => projectBuilding(b, origin))
    .filter((b): b is NonNullable<typeof b> => b != null);

  for (const b of projected) {
    const mesh = createBuildingMesh(b, false);
    scene.add(mesh);
  }

  const plate = createBasePlate(projected, options.basePlateMm, options.metersToMm);
  if (plate) {
    const mat = new THREE.MeshStandardMaterial({ color: '#8a8f98', flatShading: true });
    scene.add(new THREE.Mesh(plate, mat));
  }

  const scale = options.metersToMm; // convert meters → mm for slicers
  scene.scale.set(scale, scale, scale);

  return { scene, count: projected.length, origin };
}

export function exportStl(
  buildings: BuildingFeature[],
  bbox: BBox,
  options: ExportOptions,
): { blob: Blob; count: number; filename: string } {
  const { scene, count, origin } = buildExportScene(buildings, bbox, options);
  if (count === 0) {
    throw new Error('Brak budynków w zaznaczeniu');
  }
  const exporter = new STLExporter();
  const result = exporter.parse(scene, { binary: options.binary });
  const blob =
    typeof result === 'string'
      ? new Blob([result], { type: 'text/plain' })
      : new Blob([result], { type: 'application/octet-stream' });

  // dispose
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material.dispose();
    }
  });

  const filename = `mapmold_${origin.lat.toFixed(4)}_${origin.lng.toFixed(4)}_${options.metersToMm}mm.stl`;
  return { blob, count, filename };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
