import { useEffect, useRef } from 'react';
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type MapMouseEvent,
  type MapTouchEvent,
  type PointLike,
} from 'maplibre-gl';
import './setupMapLibre';
import { createBuildingsLayer, type BuildingsLayerApi } from './buildingsLayer';
import {
  isMeaningfulScreenRect,
  normalizeScreenRect,
  screenRectToGeoBBox,
} from '../geo/selection';
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

function pointXY(point: { x: number; y: number } | PointLike): { x: number; y: number } {
  if (Array.isArray(point)) return { x: point[0], y: point[1] };
  return { x: point.x, y: point.y };
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
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const draftRectRef = useRef<ReturnType<typeof normalizeScreenRect> | null>(null);
  const draftBBoxRef = useRef<BBox | null>(null);
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

    const geoFromScreen = (rect: ReturnType<typeof normalizeScreenRect>): BBox =>
      screenRectToGeoBBox((x, y) => {
        const ll = map.unproject([x, y]);
        return { lng: ll.lng, lat: ll.lat };
      }, rect);

    const previewSelection = (rect: ReturnType<typeof normalizeScreenRect>) => {
      const bbox = geoFromScreen(rect);
      draftRectRef.current = rect;
      draftBBoxRef.current = bbox;
      layer.setSelectionBBox(bbox);
      setOverlay(bbox);
    };

    let boot = 0;
    const syncReady = () => {
      if (mapReadyRef.current) return;
      if (!map.isStyleLoaded()) return;
      mapReadyRef.current = true;
      window.clearInterval(boot);
      if (!map.getLayer(layer.id)) map.addLayer(layer);

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
      map.resize();
      const c = map.getCenter();
      onMoveEndRef.current({ lng: c.lng, lat: c.lat }, map.getZoom(), mapBoundsToBBox(map));
    };

    map.on('load', syncReady);
    map.on('error', (e) => console.error('MapLibre error', e.error ?? e));
    boot = window.setInterval(syncReady, 250);

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

    type MapPointerEvent = MapMouseEvent | MapTouchEvent;

    const onPointerDown = (e: MapPointerEvent) => {
      if (!selectingRef.current) return;
      const oe = e.originalEvent as MouseEvent | TouchEvent;
      if ('button' in oe && typeof oe.button === 'number' && oe.button !== 0) return;
      e.preventDefault();
      dragStartRef.current = pointXY(e.point);
      draftRectRef.current = null;
      draftBBoxRef.current = null;
      map.dragPan.disable();
      map.touchZoomRotate.disable();
    };

    const onPointerMove = (e: MapPointerEvent) => {
      if (!selectingRef.current || !dragStartRef.current) return;
      const start = dragStartRef.current;
      const end = pointXY(e.point);
      previewSelection(normalizeScreenRect(start.x, start.y, end.x, end.y));
    };

    const finishDrag = () => {
      if (!dragStartRef.current) return;
      dragStartRef.current = null;
      map.dragPan.enable();
      map.touchZoomRotate.enable();
      const rect = draftRectRef.current;
      const bbox = draftBBoxRef.current;
      draftRectRef.current = null;
      draftBBoxRef.current = null;

      if (rect && bbox && isMeaningfulScreenRect(rect)) {
        layer.setSelectionBBox(bbox);
        setOverlay(bbox);
        onSelectionChangeRef.current(bbox);
      } else {
        layer.setSelectionBBox(selectionRef.current);
        setOverlay(selectionRef.current);
      }
    };

    map.on('mousedown', onPointerDown as (e: MapMouseEvent) => void);
    map.on('mousemove', onPointerMove as (e: MapMouseEvent) => void);
    map.on('mouseup', finishDrag);
    // Touch: MapLibre emits touch* ; also listen so mobile selects work.
    map.on('touchstart', onPointerDown as (e: MapTouchEvent) => void);
    map.on('touchmove', onPointerMove as (e: MapTouchEvent) => void);
    map.on('touchend', finishDrag);
    map.on('touchcancel', finishDrag);
    window.addEventListener('mouseup', finishDrag);
    window.addEventListener('touchend', finishDrag);

    mapRef.current = map;

    return () => {
      window.clearInterval(boot);
      if (resizeRaf) window.cancelAnimationFrame(resizeRaf);
      resizeObserver.disconnect();
      window.removeEventListener('mouseup', finishDrag);
      window.removeEventListener('touchend', finishDrag);
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
