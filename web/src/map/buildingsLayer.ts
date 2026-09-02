import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from 'maplibre-gl';
import * as THREE from 'three';
import { lngLatToLocal, ringIntersectsBBox } from '../geo/projection';
import { createBuildingMesh, projectBuilding } from '../mesh/lod2';
import type { BBox, BuildingFeature, Origin } from '../types';

export type BuildingsLayerApi = {
  setBuildings: (buildings: BuildingFeature[], origin: Origin) => void;
  setSelectionBBox: (bbox: BBox | null) => void;
  setSelectedIds: (ids: Iterable<string>) => void;
  getSelectedCount: () => number;
};

export function createBuildingsLayer(id = 'buildings-3d'): CustomLayerInterface & BuildingsLayerApi {
  let map: MapLibreMap | undefined;
  let renderer: THREE.WebGLRenderer | undefined;
  let scene: THREE.Scene | undefined;
  let camera: THREE.Camera | undefined;
  let root: THREE.Group | undefined;
  let selectionHelper: THREE.LineSegments | null = null;
  let modelOrigin: Origin = { lng: 21.0122, lat: 52.2297 };
  let modelTransform = { translateX: 0, translateY: 0, translateZ: 0, scale: 1 };
  let selectedIds = new Set<string>();
  let buildings: BuildingFeature[] = [];
  let ready = false;

  function updateTransform(origin: Origin) {
    modelOrigin = origin;
    const mc = MercatorCoordinate.fromLngLat([origin.lng, origin.lat], 0);
    modelTransform = {
      translateX: mc.x,
      translateY: mc.y,
      translateZ: mc.z,
      scale: mc.meterInMercatorCoordinateUnits(),
    };
  }

  function disposeObject(obj: THREE.Object3D) {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      const mat = obj.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  }

  function rebuildMeshes() {
    if (!ready || !root) return;

    while (root.children.length) {
      const child = root.children.pop()!;
      disposeObject(child);
    }

    for (const b of buildings) {
      const projected = projectBuilding(b, modelOrigin);
      if (!projected) continue;
      root.add(createBuildingMesh(projected, selectedIds.has(b.id)));
    }

    if (selectionHelper) root.add(selectionHelper);
    map?.triggerRepaint();
  }

  function applySelectionColors() {
    if (!root) return;
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.userData.buildingId) {
        const selected = selectedIds.has(obj.userData.buildingId as string);
        (obj.material as THREE.MeshStandardMaterial).color.set(selected ? '#e07a3d' : '#c4b4a0');
      }
    });
    map?.triggerRepaint();
  }

  const layer: CustomLayerInterface & BuildingsLayerApi = {
    id,
    type: 'custom',
    renderingMode: '3d',

    onAdd(mapInstance, gl) {
      map = mapInstance;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      root = new THREE.Group();
      scene.add(root);

      const light = new THREE.DirectionalLight(0xffffff, 1.15);
      light.position.set(100, 140, 80);
      scene.add(light);
      scene.add(new THREE.AmbientLight(0xffffff, 0.42));

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl as WebGLRenderingContext,
        antialias: true,
      });
      renderer.autoClear = false;
      updateTransform(modelOrigin);
      ready = true;
      rebuildMeshes();
    },

    onRemove() {
      ready = false;
      if (root) {
        while (root.children.length) {
          const child = root.children.pop()!;
          disposeObject(child);
        }
      }
      renderer?.dispose();
      map = undefined;
      root = undefined;
      scene = undefined;
      camera = undefined;
      renderer = undefined;
      selectionHelper = null;
    },

    render(_gl, options: CustomRenderMethodInput) {
      if (!ready || !renderer || !scene || !camera || !map) return;
      const matrix =
        options.modelViewProjectionMatrix ?? options.defaultProjectionData?.mainMatrix;
      if (!matrix) return;

      const rotationX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      const m = new THREE.Matrix4().fromArray(Array.from(matrix) as number[]);
      const l = new THREE.Matrix4()
        .makeTranslation(
          modelTransform.translateX,
          modelTransform.translateY,
          modelTransform.translateZ,
        )
        .scale(new THREE.Vector3(modelTransform.scale, -modelTransform.scale, modelTransform.scale))
        .multiply(rotationX);

      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      // Keep the three.js viewport locked to the full drawing buffer. The renderer
      // shares MapLibre's GL context, and without this the 3D layer can stay pinned
      // to a stale (often smaller) viewport after a resize / HiDPI change, leaving
      // buildings squeezed into a corner of the map.
      const canvas = map.getCanvas();
      renderer.setViewport(0, 0, canvas.width, canvas.height);
      renderer.render(scene, camera);
      // Do not call map.triggerRepaint() every frame — it can starve base map tiles.
    },

    setBuildings(next, origin) {
      buildings = next;
      updateTransform(origin);
      rebuildMeshes();
    },

    setSelectionBBox(bbox) {
      if (selectionHelper) {
        disposeObject(selectionHelper);
        root?.remove(selectionHelper);
        selectionHelper = null;
      }

      if (!bbox) {
        selectedIds = new Set();
        applySelectionColors();
        return;
      }

      const a = lngLatToLocal(bbox.west, bbox.south, modelOrigin);
      const b = lngLatToLocal(bbox.east, bbox.south, modelOrigin);
      const c = lngLatToLocal(bbox.east, bbox.north, modelOrigin);
      const d = lngLatToLocal(bbox.west, bbox.north, modelOrigin);
      const y = 1;
      const pts = new Float32Array([
        a.x, y, -a.y, b.x, y, -b.y,
        b.x, y, -b.y, c.x, y, -c.y,
        c.x, y, -c.y, d.x, y, -d.y,
        d.x, y, -d.y, a.x, y, -a.y,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      selectionHelper = new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({ color: '#e07a3d' }),
      );
      root?.add(selectionHelper);

      selectedIds = new Set(
        buildings.filter((bldg) => ringIntersectsBBox(bldg.outer, bbox)).map((bldg) => bldg.id),
      );
      applySelectionColors();
    },

    setSelectedIds(ids) {
      selectedIds = new Set(ids);
      applySelectionColors();
    },

    getSelectedCount() {
      return selectedIds.size;
    },
  };

  return layer;
}
