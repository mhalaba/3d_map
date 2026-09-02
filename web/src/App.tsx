import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView } from './map/MapView';
import { fetchBuildings } from './data/overpass';
import { bboxAreaKm2, bboxCenter } from './geo/projection';
import { downloadBlob, exportStl, filterBuildingsInBBox } from './export/stl';
import type { BBox, BuildingFeature, Origin } from './types';
import './App.css';

const MAX_AREA_KM2 = 1.5;
const DEFAULT_ORIGIN: Origin = { lng: 21.0122, lat: 52.2297 }; // Warszawa

export default function App() {
  const [buildings, setBuildings] = useState<BuildingFeature[]>([]);
  const [origin, setOrigin] = useState<Origin>(DEFAULT_ORIGIN);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<BBox | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Przesuń mapę, aby wczytać budynki OSM');
  const [metersToMm, setMetersToMm] = useState(1); // 1:1000
  const [basePlateMm, setBasePlateMm] = useState(2);
  const [exporting, setExporting] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const fetchTimer = useRef<number | null>(null);
  const viewBBoxRef = useRef<BBox | null>(null);

  const selectedCount = useMemo(
    () => (selection ? filterBuildingsInBBox(buildings, selection).length : 0),
    [buildings, selection],
  );

  const loadForBBox = useCallback(async (bbox: BBox) => {
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
    (_center: Origin, zoom: number, viewBBox: BBox) => {
      viewBBoxRef.current = viewBBox;
      if (zoom < 14.5) {
        setStatus('Przybliż mapę (zoom ≥ 15), aby wczytać budynki 3D');
        return;
      }
      if (fetchTimer.current) window.clearTimeout(fetchTimer.current);
      fetchTimer.current = window.setTimeout(() => {
        void loadForBBox(viewBBox);
      }, 550);
    },
    [loadForBBox],
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (fetchTimer.current) window.clearTimeout(fetchTimer.current);
    };
  }, []);

  const startSelect = () => {
    setSelecting(true);
    setSelection(null);
    setStatus('Przeciągnij prostokąt na mapie, aby zaznaczyć obszar eksportu');
  };

  const clearSelect = () => {
    setSelecting(false);
    setSelection(null);
    setStatus(`Załadowano ${buildings.length} obiektów`);
  };

  const handleExport = () => {
    if (!selection) return;
    const area = bboxAreaKm2(selection);
    if (area > MAX_AREA_KM2) {
      setError(`Zaznaczenie zbyt duże (${area.toFixed(2)} km²). Max ${MAX_AREA_KM2} km².`);
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const { blob, count, filename } = exportStl(buildings, selection, {
        metersToMm,
        basePlateMm,
        binary: true,
      });
      downloadBlob(blob, filename);
      setStatus(`Wyeksportowano ${count} budynków → ${filename}`);
      setSelecting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Eksport nieudany');
    } finally {
      setExporting(false);
    }
  };

  const selectionArea = selection ? bboxAreaKm2(selection) : 0;

  return (
    <div className="app">
      <MapView
        buildings={buildings}
        origin={origin}
        selecting={selecting}
        selection={selection}
        onSelectionChange={setSelection}
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
            onClick={() => viewBBoxRef.current && void loadForBBox(viewBBoxRef.current)}
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
        <section className="export-panel">
          <h2>Eksport STL</h2>
          <p>
            {selectedCount} budynków · {selectionArea.toFixed(3)} km² · dachy LoD2 (
            gabled / hipped / pyramidal / skillion / dome)
          </p>
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
            onClick={handleExport}
            disabled={exporting || selectedCount === 0}
          >
            {exporting ? 'Generowanie…' : 'Pobierz STL'}
          </button>
        </section>
      )}

      <footer className="attrib">
        Dane mapy © OpenStreetMap contributors · styl OpenFreeMap · LoD2 z tagów roof:*
      </footer>
    </div>
  );
}
