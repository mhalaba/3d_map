import { useEffect, useRef } from 'react';
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type MapMouseEvent,
} from 'maplibre-gl';
import './setupMapLibre';
import { createBuildingsLayer, type BuildingsLayerApi } from './buildingsLayer';
import type { BBox, BuildingFeature, Origin } from '../types';
import 'maplibre-gl/dist/maplibre-gl.css';

const SELECTION_SOURCE = 'selection-area';

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

function bboxToFeatureCollection(bbox: BBox) {
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [bbox.west, bbox.south],
              [bbox.east, bbox.south],
              [bbox.east, bbox.north],
              [bbox.west, bbox.north],
              [bbox.west, bbox.south],
            ],
          ],
        },
      },
    ],
  };
}

export type MapViewProps = {
  buildings: BuildingFeature[];
  origin: Origin;
  selecting: boolean;
  selection: BBox | null;
  onSelectionChange: (bbox: BBox | null) => void;
  onMoveEnd: (center: Origin, zoom: number, viewBBox: BBox) => void;
};

function mapBoundsToBBox(map: MapLibreMap): BBox {
  const b = map.getBounds();
  return {
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
  };
}

export function MapView({
  buildings,
  origin,
  selecting,
  selection,
  onSelectionChange,
  onMoveEnd,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const layerRef = useRef<(ReturnType<typeof createBuildingsLayer> & BuildingsLayerApi) | null>(
    null,
  );
  const mapReadyRef = useRef(false);
  const dragStartRef = useRef<[number, number] | null>(null);
  const selectingRef = useRef(selecting);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onMoveEndRef = useRef(onMoveEnd);
  const buildingsRef = useRef(buildings);
  const originRef = useRef(origin);
  const selectionRef = useRef(selection);
  const setOverlayRef = useRef<(bbox: BBox | null) => void>(() => {});

  selectingRef.current = selecting;
  onSelectionChangeRef.current = onSelectionChange;
  onMoveEndRef.current = onMoveEnd;
  buildingsRef.current = buildings;
  originRef.current = origin;
  selectionRef.current = selection;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [originRef.current.lng, originRef.current.lat],
      zoom: 16,
      pitch: 60,
      bearing: -20,
      maxPitch: 80,
    });

    map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new ScaleControl({ maxWidth: 120 }), 'bottom-left');

    const layer = createBuildingsLayer();
    layerRef.current = layer;

    const setOverlay = (bbox: BBox | null) => {
      const src = map.getSource(SELECTION_SOURCE) as GeoJSONSource | undefined;
      if (!src) return;
      src.setData(bbox ? bboxToFeatureCollection(bbox) : EMPTY_FC);
    };
    setOverlayRef.current = setOverlay;

    let boot = 0;
    const syncReady = () => {
      if (mapReadyRef.current) return;
      if (!map.isStyleLoaded()) return;
      mapReadyRef.current = true;
      window.clearInterval(boot);
      if (!map.getLayer(layer.id)) map.addLayer(layer);

      // Selection highlight overlay, drawn above the 3D buildings so the chosen
      // area is always clearly visible (translucent fill + bold dashed outline).
      if (!map.getSource(SELECTION_SOURCE)) {
        map.addSource(SELECTION_SOURCE, { type: 'geojson', data: EMPTY_FC });
        map.addLayer({
          id: 'selection-fill',
          type: 'fill',
          source: SELECTION_SOURCE,
          paint: { 'fill-color': '#ff7a1a', 'fill-opacity': 0.2 },
        });
        map.addLayer({
          id: 'selection-outline',
          type: 'line',
          source: SELECTION_SOURCE,
          paint: {
            'line-color': '#ff7a1a',
            'line-width': 3,
            'line-dasharray': [2, 1],
          },
        });
      }

      layer.setBuildings(buildingsRef.current, originRef.current);
      if (selectionRef.current) {
        layer.setSelectionBBox(selectionRef.current);
        setOverlay(selectionRef.current);
      }
      // Correct any initial size mismatch (fonts/layout settling, HiDPI) so the
      // map canvas fills its container instead of a partial strip.
      map.resize();
      const c = map.getCenter();
      onMoveEndRef.current({ lng: c.lng, lat: c.lat }, map.getZoom(), mapBoundsToBBox(map));
    };

    map.on('load', syncReady);
    map.on('error', (e) => console.error('MapLibre error', e.error ?? e));
    boot = window.setInterval(syncReady, 250);

    // Keep the map sized to its container even when the window itself does not
    // resize (split layouts, devtools, late layout shifts). Guarded by rAF to
    // coalesce bursts.
    let resizeRaf = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRaf) return;
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = 0;
        if (mapRef.current) mapRef.current.resize();
      });
    });
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    map.on('moveend', () => {
      const c = map.getCenter();
      onMoveEndRef.current({ lng: c.lng, lat: c.lat }, map.getZoom(), mapBoundsToBBox(map));
    });

    const onMouseDown = (e: MapMouseEvent) => {
      if (!selectingRef.current) return;
      if (e.originalEvent.button !== 0) return;
      e.preventDefault();
      dragStartRef.current = [e.lngLat.lng, e.lngLat.lat];
      map.dragPan.disable();
    };

    const onMouseMove = (e: MapMouseEvent) => {
      if (!selectingRef.current || !dragStartRef.current) return;
      const [lng0, lat0] = dragStartRef.current;
      const bbox: BBox = {
        west: Math.min(lng0, e.lngLat.lng),
        east: Math.max(lng0, e.lngLat.lng),
        south: Math.min(lat0, e.lngLat.lat),
        north: Math.max(lat0, e.lngLat.lat),
      };
      layer.setSelectionBBox(bbox);
      setOverlay(bbox);
      onSelectionChangeRef.current(bbox);
    };

    const onMouseUp = () => {
      if (!dragStartRef.current) return;
      dragStartRef.current = null;
      map.dragPan.enable();
    };

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);

    mapRef.current = map;

    return () => {
      window.clearInterval(boot);
      if (resizeRaf) window.cancelAnimationFrame(resizeRaf);
      resizeObserver.disconnect();
      mapReadyRef.current = false;
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapReadyRef.current) return;
    layerRef.current?.setBuildings(buildings, origin);
  }, [buildings, origin]);

  useEffect(() => {
    if (!mapReadyRef.current) return;
    layerRef.current?.setSelectionBBox(selection);
    setOverlayRef.current(selection);
  }, [selection]);

  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = selecting ? 'crosshair' : '';
  }, [selecting]);

  return <div className="map-root" ref={containerRef} />;
}
