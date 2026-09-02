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

function toArrayBuffer(result: DataView | ArrayBuffer): ArrayBuffer {
  if (result instanceof ArrayBuffer) return result;
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
}

/** Validate a binary STL: header triangle count must match file size. */
export function validateBinaryStl(buffer: ArrayBuffer): { ok: true; triangles: number } | { ok: false; reason: string } {
  if (buffer.byteLength < 84) {
    return { ok: false, reason: `Plik za mały (${buffer.byteLength} B)` };
  }
  const view = new DataView(buffer);
  const triangles = view.getUint32(80, true);
  const expected = 84 + triangles * 50;
  if (buffer.byteLength !== expected) {
    return {
      ok: false,
      reason: `Niespójny STL: ${buffer.byteLength} B przy ${triangles} trójkątach (oczekiwano ${expected} B)`,
    };
  }
  if (triangles < 4) {
    return { ok: false, reason: `Za mało geometrii (${triangles} trójkątów)` };
  }
  // Spot-check first / mid / last triangle for non-finite floats
  const samples = [0, Math.floor(triangles / 2), triangles - 1];
  for (const i of samples) {
    const off = 84 + i * 50;
    for (let f = 0; f < 12; f++) {
      const v = view.getFloat32(off + f * 4, true);
      if (!Number.isFinite(v)) {
        return { ok: false, reason: `Nieprawidłowa liczba w trójkącie ${i}` };
      }
    }
  }
  return { ok: true, triangles };
}

export function exportStl(
  buildings: BuildingFeature[],
  bbox: BBox,
  options: ExportOptions,
): { blob: Blob; buffer: ArrayBuffer; count: number; filename: string; triangles: number } {
  const { scene, count, origin } = buildExportScene(buildings, bbox, options);
  if (count === 0) {
    throw new Error('Brak budynków w zaznaczeniu');
  }
  const exporter = new STLExporter();
  const result = exporter.parse(scene, { binary: options.binary });

  let buffer: ArrayBuffer;
  let blob: Blob;
  if (typeof result === 'string') {
    buffer = new TextEncoder().encode(result).buffer as ArrayBuffer;
    blob = new Blob([result], { type: 'model/stl' });
  } else {
    buffer = toArrayBuffer(result);
    const check = validateBinaryStl(buffer);
    if (!check.ok) {
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
      throw new Error(check.reason);
    }
    // Copy into a fresh ArrayBuffer-backed Uint8Array for maximum Blob compatibility
    // (some browsers are picky about DataView / SharedArrayBuffer views).
    const bytes = new Uint8Array(buffer.byteLength);
    bytes.set(new Uint8Array(buffer));
    buffer = bytes.buffer;
    blob = new Blob([bytes], { type: 'model/stl' });
  }

  const triangles =
    typeof result === 'string'
      ? 0
      : (validateBinaryStl(buffer) as { ok: true; triangles: number }).triangles;

  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material.dispose();
    }
  });

  const filename = `mapmold_${origin.lat.toFixed(4)}_${origin.lng.toFixed(4)}_${options.metersToMm}mm.stl`;
  return { blob, buffer, count, filename, triangles };
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

/**
 * Trigger a file download. Tries the File System Access save picker first
 * (Chromium), then a DOM-attached anchor click. Returns an object URL the UI
 * can expose as a manual fallback link (caller should revoke when done).
 */
export async function downloadBlob(
  blob: Blob,
  filename: string,
): Promise<{ objectUrl: string; method: 'picker' | 'anchor' }> {
  const w = window as SaveFilePickerWindow;
  // Skip the save picker under WebDriver/automation — it blocks headless tests
  // and has no download event. Real browsers still get the picker first.
  const automated = navigator.webdriver === true;
  if (!automated && typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'STL',
            accept: {
              'model/stl': ['.stl'],
              'application/octet-stream': ['.stl'],
            },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      // Still create an object URL so the UI can offer "pobierz ponownie".
      const objectUrl = URL.createObjectURL(blob);
      return { objectUrl, method: 'picker' };
    } catch (err) {
      // User cancelled the picker — don't fall through to auto-download.
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // Picker unavailable / denied — fall through to anchor download.
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  a.rel = 'noopener';
  a.type = blob.type || 'model/stl';
  a.style.display = 'none';
  // Anchor must be in the document; defer revoke so the browser can start the download.
  document.body.appendChild(a);
  a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  window.setTimeout(() => {
    a.remove();
  }, 4000);
  return { objectUrl, method: 'anchor' };
}
