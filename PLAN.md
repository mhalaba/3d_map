# Plan: Mapa 3D OSM → eksport STL

Aplikacja webowa do przeglądania mapy OpenStreetMap z budynkami i obiektami 3D, zaznaczania fragmentu terenu oraz eksportu geometrii do pliku STL (np. do druku 3D).

---

## 1. Cel produktu

Użytkownik:

1. Otwiera mapę (OSM) w widoku 3D.
2. Widzi budynki i wybrane obiekty jako modele 3D (głównie LoD1: obrys + wysokość).
3. Zaznacza prostokąt / wielokąt na mapie.
4. Eksportuje zaznaczony fragment do pliku `.stl`.

**MVP:** budynki LoD1 + teren płaski + eksport STL zaznaczonego bboxa.

---

## 2. Zakres MVP vs później

### MVP (v1)

- Mapa bazowa OSM (raster lub wektor)
- Widok 3D z kamerą orbit / tilt / zoom
- Budynki z OSM: footprint + `height` / `building:levels`
- Zaznaczenie prostokątem (bbox)
- Generowanie siatki 3D (extrude) i eksport STL
- Podgląd zaznaczenia przed eksportem
- Działa w przeglądarce (bez konta)

### v1.1

- Zaznaczenie wielokątem
- Przycinanie budynków do granicy zaznaczenia
- Opcje skali (mm/m) i wysokości bazowej (podstawa pod druk)
- Uproszczenie siatki (decimation) przed eksportem
- Warstwy: budynki / drogi / woda (opcjonalnie jako płaskie lub lekkie extrude)

### v2

- Dachy LoD2 (`roof:shape`, `roof:height`)
- Relief terenu (DEM, np. Mapzen/OpenTopography / lokalny tile)
- Cache / tile’owanie geometrii
- Eksport GLTF/OBJ obok STL
- Limit obszaru + kolejka eksportu po stronie serwera dla dużych bboxów

---

## 3. Architektura wysokopoziomowa

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Frontend   │────▶│  Overpass /      │────▶│  OSM buildings  │
│  Map+3D UI  │     │  vector tiles    │     │  + tags         │
└──────┬──────┘     └──────────────────┘     └─────────────────┘
       │
       │ zaznaczenie bbox / polygon
       ▼
┌──────────────────┐     ┌─────────────────┐
│ Mesh builder     │────▶│ STL exporter    │
│ (extrude, merge) │     │ (.stl download) │
└──────────────────┘     └─────────────────┘
```

**Rekomendacja na start:** architektura **client-heavy**.

- Frontend pobiera dane OSM, buduje mesh w Three.js, eksportuje STL lokalnie.
- Backend opcjonalny na MVP (może być tylko static hosting).
- Backend warto dodać później: proxy Overpass, cache, limity, eksport dużych obszarów.

---

## 4. Stack technologiczny (propozycja)

| Warstwa | Technologia | Powód |
|--------|-------------|--------|
| UI | React + TypeScript + Vite | szybki start, typowanie |
| Mapa 2D/3D | MapLibre GL JS | OSM-friendly, open source |
| 3D / mesh | Three.js | kamera, materiały, STLExporter |
| Integracja mapa↔3D | custom sync albo `threebox`-like layer / custom custom layer MapLibre | wspólny układ współrzędnych |
| Dane budynków | Overpass API **lub** vector tiles (OpenMapTiles / own tiles) | Overpass prostszy na MVP |
| Geometria | `@turf/turf` | bbox, intersect, clip |
| Projekcja | `proj4` / MapLibre mercator helpers | lat/lon → metry lokalne |
| Eksport | `THREE.STLExporter` | standard STL (ascii/binary) |
| Hosting | Vercel / Cloudflare Pages / Nginx | static + opcjonalne API |

### Alternatywy rozważane

- **osmbuildings / OSMBuildings**: szybki podgląd 3D, słabsza kontrola nad meshem do STL.
- **deck.gl**: dobre do dużych zbiorów, więcej boilerplate do eksportu STL.
- **Cesium**: ciężki; nadmiarowy na MVP druku 3D.
- **Backend Python (pyosmium + trimesh)**: lepszy do dużych eksportów; odłożyć do v2.

---

## 5. Źródła danych

### 5.1 Mapa bazowa

- Style: MapTiler / OpenFreeMap / self-hosted OpenMapTiles.
- Wymaganie: licencja i attribution OSM.

### 5.2 Budynki 3D (LoD1)

Pobieranie z Overpass dla widocznego / zaznaczonego obszaru:

```
[out:json][timeout:60];
(
  way["building"]({{bbox}});
  relation["building"]({{bbox}});
);
out body;
>;
out skel qt;
```

Używane tagi:

- `building=*` → footprint
- `height` (metry) lub `building:levels` × ~3 m
- fallback wysokości: np. 10 m
- opcjonalnie `min_height` / `building:min_level`

### 5.3 Inne obiekty (później)

- `highway` → opcjonalne płaskie pasy / niski extrude
- `water` / `natural=water` → płaszczyzny
- `amenity` / POI → pomijane w eksporcie STL (niepotrzebny clutter)

### 5.4 Ograniczenia jakości OSM

- Brak pełnych, gotowych modeli 3D „jak w Google Earth”.
- LoD1 = prostopadłościany / extrude obrysów.
- Dachy, detale fasad, mosty — niedokładne lub nieobecne.
- W planie produktu trzeba to jasno komunikować użytkownikowi.

---

## 6. Model współrzędnych i jednostek

Kluczowy problem: lat/lon ≠ metry ≠ mm druku.

Proponowany pipeline:

1. Weź centroid zaznaczenia jako lokalny origin.
2. Przelicz wierzchołki footprintów do lokalnego układu metrycznego (ENU / local tangent plane lub WebMercator meters relative).
3. Extrude w osi Z (góra).
4. Przed STL zastosuj skalę:
   - `1 map meter = N mm` (np. 1:1000 → 1 m = 1 mm)
5. Opcjonalnie dodaj płytę bazową (base plate) o grubości X mm.

---

## 7. UX / UI

### Ekran główny (jedna kompozycja)

- Pełnoekranowa mapa 3D jako tło / główna płaszczyzna.
- Brand / nazwa aplikacji widoczna jako sygnał hero (nie tylko w nav).
- Jedna główna akcja: **Zaznacz obszar**.
- Krótki komunikat: „Zaznacz fragment mapy i eksportuj do STL”.

### Tryby

1. **Przeglądanie** — orbit / pan / zoom.
2. **Zaznaczanie** — rysowanie bbox (v1) lub polygon (v1.1).
3. **Podgląd eksportu** — izolacja zaznaczonych obiektów, wymiary, skala.
4. **Eksport** — wybór skali, binary/ascii STL, download.

### Panel eksportu (po zaznaczeniu, nie w pierwszym viewportcie)

- Liczba budynków
- Wymiary obszaru (m)
- Skala
- Wysokość podstawy
- Przycisk „Pobierz STL”
- Ostrzeżenie przy zbyt dużym obszarze

### Limity UX

- Max bbox np. 1–2 km² w przeglądarce.
- Powyżej limitu: komunikat + (później) eksport serwerowy.

---

## 8. Pipeline generowania mesha i STL

```
OSM ways/relations
  → polygon footprints (+ holes dla courtyard)
  → clip do zaznaczenia
  → project to local meters
  → extrude (height)
  → merge geometries (BufferGeometryUtils.mergeGeometries)
  → optional base plate
  → scale to mm
  → STLExporter.parse(scene)
  → Blob download
```

### Szczegóły implementacyjne

- Normalizacja winding order (CCW) przed extrude.
- Obsługa holes (multipolygon relations).
- Usuwanie degenerate triangles.
- Binary STL domyślnie (mniejszy plik).
- Nazewnictwo pliku: `osm-export-{lat}-{lon}-{scale}.stl`.

---

## 9. Moduły aplikacji (frontend)

```
src/
  app/                 # routing, layout
  map/
    MapView.tsx        # MapLibre + 3D camera
    SelectionTool.ts   # bbox / polygon
  data/
    overpassClient.ts  # fetch buildings
    osmParse.ts        # ways → polygons
  mesh/
    extrudeBuildings.ts
    localProjection.ts
    basePlate.ts
  export/
    exportStl.ts
    scaleUnits.ts
  ui/
    ExportPanel.tsx
    ScaleControls.tsx
```

---

## 10. Backend (opcjonalnie, od v1.5 / v2)

Minimalne API:

- `POST /api/buildings` — proxy Overpass + cache Redis
- `POST /api/export/stl` — serwerowy build mesha dla dużych obszarów
- Rate limiting + max bbox

Na MVP **nie jest wymagany**.

---

## 11. Etapy realizacji

### Etap A — fundament

- Scaffold Vite + React + TS
- MapLibre z warstwą OSM
- Kamera 3D / pitch
- Attribution OSM

### Etap B — budynki 3D

- Overpass fetch dla viewportu / debounce
- Extrude LoD1 w Three.js (custom layer lub synced scene)
- Fallback wysokości

### Etap C — zaznaczanie

- Tool bbox
- Highlight budynków w zaznaczeniu
- Panel podsumowania

### Etap D — eksport STL

- Mesh builder z lokalną projekcją
- Skala mm
- STL download + test w slicerze (PrusaSlicer / Cura)

### Etap E — twardnienie

- Limity obszaru
- Loading / error states
- Testy jednostkowe projekcji i extrude
- README z instrukcją uruchomienia

---

## 12. Ryzyka i mitigacje

| Ryzyko | Impact | Mitigacja |
|--------|--------|-----------|
| Overpass timeout / rate limit | wysoki | bbox limit, debounce, cache, własny Overpass |
| Zbyt duże STL | średni | max area, decimation, binary STL |
| Złe jednostki / skala | wysoki | jasny UI skali + baza pod druk |
| Multipoligony / holes | średni | dedykowany parser relacji |
| Oczekiwanie „fotorealistycznych” 3D | produktowe | komunikat: LoD1 z OSM, nie photogrammetry |
| Licencje danych | średni | OSM attribution, info o ODbL przy eksporcie |

---

## 13. Kryteria sukcesu MVP

- Na wybranym mieście (np. centrum Warszawy) widać budynki 3D z OSM.
- Użytkownik zaznacza bbox i pobiera `.stl`.
- Plik otwiera się w slicerze i ma poprawną skalę (po ustawieniu 1:1000).
- Eksport < ~500 budynków kończy się w rozsądnym czasie w przeglądarce.
- Mapa działa na desktopie i mobile (eksport głównie desktop).

---

## 14. Decyzje do potwierdzenia przed implementacją

1. **Tylko budynki** w MVP, czy też drogi/woda?
2. **Skala domyślna** (np. 1:1000)?
3. Czy eksport ma być **w 100% w przeglądarce**, czy od razu przewidzieć API?
4. Czy potrzebny relief terenu już w v1, czy płaska podstawa wystarczy?
5. Brand / nazwa produktu (repo: `3d_map`).

---

## 15. Rekomendacja startowa

Zaczynać od:

> **React + MapLibre + Three.js + Overpass + STLExporter**
> z płaskim terenem i LoD1 buildings, zaznaczeniem bbox i eksportem client-side.

To najszybciej daje działający produkt „mapa → zaznacz → STL”, bez nadmiaru infrastruktury, z jasną ścieżką rozbudowy o polygon clip, DEM i eksport serwerowy.
