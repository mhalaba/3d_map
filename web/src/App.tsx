import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView, type SelectionCommit } from './map/MapView';
import { fetchBuildings } from './data/overpass';
import { bboxAreaKm2, bboxCenter } from './geo/projection';
import { downloadBlob, exportStl } from './export/stl';
import type { BBox, BuildingFeature, Origin } from './types';
import './App.css';

/** Load a generous box around the camera center so pitched views still have data. */
function clampBBoxAround(center: Origin, bbox: BBox, maxHalfDeg = 0.006): BBox {
  const halfLng = Math.min(Math.max((bbox.east - bbox.west) / 2, 0.0012), maxHalfDeg);
  const halfLat = Math.min(Math.max((bbox.north - bbox.south) / 2, 0.0012), maxHalfDeg);
  return {
    west: center.lng - halfLng,
    east: center.lng + halfLng,
    south: center.lat - halfLat,
    north: center.lat + halfLat,
  };
}

const MAX_AREA_KM2 = 1.5;
const DEFAULT_ORIGIN: Origin = { lng: 21.0122, lat: 52.2297 }; // Warszawa

type ReadyDownload = {
  objectUrl: string;
  filename: string;
  count: number;
  triangles: number;
  bytes: number;
};

export default function App() {
  const [buildings, setBuildings] = useState<BuildingFeature[]>([]);
  const [origin, setOrigin] = useState<Origin>(DEFAULT_ORIGIN);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<BBox | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Przesuń mapę, aby wczytać budynki OSM');
  const [metersToMm, setMetersToMm] = useState(1); // 1:1000
  const [basePlateMm, setBasePlateMm] = useState(2);
  const [exporting, setExporting] = useState(false);
  const [readyDownload, setReadyDownload] = useState<ReadyDownload | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fetchTimer = useRef<number | null>(null);
  const viewBBoxRef = useRef<BBox | null>(null);
  const readyDownloadRef = useRef<ReadyDownload | null>(null);

  const selectedBuildings = useMemo(() => {
    if (!selectedIds.length) return [];
    const idSet = new Set(selectedIds);
    return buildings.filter((b) => idSet.has(b.id));
  }, [buildings, selectedIds]);

  const selectedCount = selectedBuildings.length;

  const revokeReadyDownload = useCallback(() => {
    if (readyDownloadRef.current) {
      URL.revokeObjectURL(readyDownloadRef.current.objectUrl);
      readyDownloadRef.current = null;
      setReadyDownload(null);
    }
  }, []);

  const loadForBBox = useCallback(async (rawBBox: BBox, center?: Origin) => {
    const bbox = clampBBoxAround(center ?? bboxCenter(rawBBox), rawBBox);
    const area = bboxAreaKm2(bbox);
    if (area > MAX_AREA_KM2 * 4) {
      setStatus('Przybliż mapę, aby wczytać budynki (zbyt duży obszar)');
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    setStatus('Pobieranie budynków z OpenStreetMap…');

    try {
      const data = await fetchBuildings(bbox, ac.signal);
      if (ac.signal.aborted) return;
      setBuildings(data);
      setOrigin(bboxCenter(bbox));
      const withRoof = data.filter((b) => b.tags.roofShape && b.tags.roofShape !== 'flat').length;
      setStatus(
        `Załadowano ${data.length} obiektów · LoD2 dachów: ${withRoof} · źródło: OSM / Overpass`,
      );
    } catch (err) {
      if (ac.signal.aborted) return;
      const msg = err instanceof Error ? err.message : 'Błąd pobierania';
      setError(msg);
      setStatus('Nie udało się pobrać danych');
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  const onMoveEnd = useCallback(
    (center: Origin, zoom: number, viewBBox: BBox) => {
      viewBBoxRef.current = viewBBox;
      if (zoom < 14.5) {
        setStatus('Przybliż mapę (zoom ≥ 15), aby wczytać budynki 3D');
        return;
      }
      if (fetchTimer.current) window.clearTimeout(fetchTimer.current);
      fetchTimer.current = window.setTimeout(() => {
        void loadForBBox(viewBBox, center);
      }, 550);
    },
    [loadForBBox],
  );

  useEffect(() => {
    const pad = 0.005;
    void loadForBBox({
      west: DEFAULT_ORIGIN.lng - pad,
      east: DEFAULT_ORIGIN.lng + pad,
      south: DEFAULT_ORIGIN.lat - pad,
      north: DEFAULT_ORIGIN.lat + pad,
    });
    return () => {
      abortRef.current?.abort();
      if (fetchTimer.current) window.clearTimeout(fetchTimer.current);
      revokeReadyDownload();
    };
  }, [loadForBBox, revokeReadyDownload]);

  // Keep selected IDs valid after a buildings refresh.
  useEffect(() => {
    if (!selectedIds.length) return;
    const alive = new Set(buildings.map((b) => b.id));
    const next = selectedIds.filter((id) => alive.has(id));
    if (next.length !== selectedIds.length) setSelectedIds(next);
  }, [buildings, selectedIds]);

  const startSelect = () => {
    setSelecting(true);
    setSelection(null);
    setSelectedIds([]);
    revokeReadyDownload();
    setError(null);
    setStatus('Przeciągnij prostokąt na beżowych bryłach 3D');
  };

  const clearSelect = () => {
    setSelecting(false);
    setSelection(null);
    setSelectedIds([]);
    revokeReadyDownload();
    setStatus(`Załadowano ${buildings.length} obiektów`);
  };

  const commitSelection = useCallback(
    (commit: SelectionCommit | null) => {
      if (!commit) {
        setSelection(null);
        setSelectedIds([]);
        return;
      }
      setSelection(commit.bbox);
      setSelectedIds(commit.buildingIds);
      setSelecting(false);
      if (commit.buildingIds.length === 0) {
        if (buildings.length === 0) {
          setStatus('Brak wczytanych budynków OSM — kliknij Odśwież OSM');
          setError('Najpierw wczytaj budynki 3D (Overpass), potem zaznacz ponownie.');
        } else {
          setStatus('Zaznaczenie bez brył 3D — spróbuj większy prostokąt na beżowych budynkach');
          setError(null);
        }
      } else {
        setError(null);
        setStatus(
          `Zaznaczono ${commit.buildingIds.length} budynków — ustaw skalę i pobierz STL`,
        );
      }
    },
    [buildings.length],
  );

  const handleExport = async () => {
    if (!selection) return;
    if (selectedCount === 0) {
      setError(
        buildings.length === 0
          ? 'Brak wczytanych budynków OSM. Kliknij Odśwież OSM.'
          : 'Brak budynków 3D w zaznaczeniu. Zaznacz beżowe bryły na mapie.',
      );
      return;
    }
    const area = bboxAreaKm2(selection);
    if (area > MAX_AREA_KM2) {
      setError(`Zaznaczenie zbyt duże (${area.toFixed(2)} km²). Max ${MAX_AREA_KM2} km².`);
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const { blob, count, filename, triangles } = exportStl(selectedBuildings, selection, {
        metersToMm,
        basePlateMm,
        binary: true,
        prefiltered: true,
      });
      const { objectUrl, method } = await downloadBlob(blob, filename);
      revokeReadyDownload();
      const next: ReadyDownload = {
        objectUrl,
        filename,
        count,
        triangles,
        bytes: blob.size,
      };
      readyDownloadRef.current = next;
      setReadyDownload(next);
      setStatus(
        method === 'picker'
          ? `Zapisano ${count} budynków (${triangles} trójkątów) → ${filename}`
          : `Wyeksportowano ${count} budynków (${triangles} trójkątów) → ${filename}`,
      );
      setSelecting(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatus('Anulowano zapis pliku');
      } else {
        setError(err instanceof Error ? err.message : 'Eksport nieudany');
      }
    } finally {
      setExporting(false);
    }
  };

  const selectionArea = selection ? bboxAreaKm2(selection) : 0;
  const exportBlocked = exporting || selectedCount === 0;

  return (
    <div className="app">
      <MapView
        buildings={buildings}
        origin={origin}
        selecting={selecting}
        selection={selection}
        selectedIds={selectedIds}
        onSelectionChange={commitSelection}
        onMoveEnd={onMoveEnd}
      />

      <div className="atmosphere" aria-hidden />

      <header className="hero">
        <p className="brand">MapMold</p>
        <h1>Mapa OSM w LoD2, gotowa do druku</h1>
        <p className="lede">
          Budynki i dachy z OpenStreetMap na żywej mapie. Zaznacz fragment i pobierz STL.
        </p>
        <div className="cta-row">
          {!selecting ? (
            <button type="button" className="btn primary" onClick={startSelect}>
              Zaznacz obszar
            </button>
          ) : (
            <button type="button" className="btn ghost" onClick={clearSelect}>
              Anuluj zaznaczenie
            </button>
          )}
          <button
            type="button"
            className="btn ghost"
            onClick={() =>
              viewBBoxRef.current &&
              void loadForBBox(viewBBoxRef.current, origin)
            }
            disabled={loading}
          >
            {loading ? 'Wczytywanie…' : 'Odśwież OSM'}
          </button>
        </div>
      </header>

      <aside className="hud" aria-live="polite">
        <div className="hud-line">{status}</div>
        {error && <div className="hud-error">{error}</div>}
      </aside>

      {selection && (
        <section className="export-panel" data-testid="export-panel">
          <h2>Eksport STL</h2>
          <p>
            {selectedCount} budynków · {selectionArea.toFixed(3)} km² · dachy LoD2 (
            gabled / hipped / pyramidal / skillion / dome)
          </p>
          {selectedCount === 0 && (
            <p className="export-warn">
              {buildings.length === 0
                ? 'Brak wczytanych budynków OSM — kliknij Odśwież OSM, poczekaj na beżowe bryły 3D.'
                : `Załadowano ${buildings.length} brył, ale żadna nie trafiła w prostokąt. Zaznacz większy obszar bezpośrednio na beżowych budynkach 3D (nie na szarym planie 2D).`}
            </p>
          )}
          <label className="field">
            <span>Skala (1 m mapy → mm w STL)</span>
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={metersToMm}
              onChange={(e) => setMetersToMm(Number(e.target.value) || 1)}
            />
            <small>1 = skala 1:1000 (1 m → 1 mm)</small>
          </label>
          <label className="field">
            <span>Podstawa (mm)</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={basePlateMm}
              onChange={(e) => setBasePlateMm(Number(e.target.value) || 0)}
            />
          </label>
          <button
            type="button"
            className="btn primary wide"
            onClick={() => void handleExport()}
            disabled={exportBlocked}
            aria-disabled={exportBlocked}
            title={
              selectedCount === 0
                ? 'Zaznacz obszar zawierający budynki 3D'
                : 'Pobierz plik STL do druku 3D'
            }
          >
            {exporting ? 'Generowanie…' : 'Pobierz STL'}
          </button>
          {readyDownload && (
            <a
              className="btn ghost wide download-fallback"
              href={readyDownload.objectUrl}
              download={readyDownload.filename}
              rel="noopener"
            >
              Pobierz ponownie ({Math.round(readyDownload.bytes / 1024)} KB ·{' '}
              {readyDownload.triangles} tri)
            </a>
          )}
        </section>
      )}

      <footer className="attrib">
        Dane mapy © OpenStreetMap contributors · styl OpenFreeMap · LoD2 z tagów roof:*
      </footer>
    </div>
  );
}
