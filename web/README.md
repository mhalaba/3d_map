# MapMold (3d_map)

Aplikacja webowa: OpenStreetMap + budynki 3D **LoD2** (dachy) + eksport zaznaczenia do **STL**.

## Stack

- React + TypeScript + Vite
- MapLibre GL (mapa OSM / OpenFreeMap)
- Three.js (mesh LoD2 + custom layer)
- Overpass API (budynki i tagi `roof:*`)
- STLExporter (binary STL)

## Uruchomienie

```bash
cd web
npm install
npm run dev
```

Otwórz lokalny URL Vite. Domyślny widok: centrum Warszawy.

## Użycie

1. Przybliż mapę (zoom ≥ 15) — budynki wczytają się z OSM.
2. Kliknij **Zaznacz obszar** i przeciągnij prostokąt.
3. Ustaw skalę (domyślnie 1 m → 1 mm = 1:1000) i podstawę.
4. **Pobierz STL** — plik otworzysz w slicerze.

## LoD2

Obsługiwane `roof:shape`: `flat`, `gabled`, `gambrel`, `hipped`, `mansard`, `pyramidal`, `onion`, `skillion`, `dome`, `round`.

Wysokości z `height`, `building:levels`, `roof:height`, `roof:levels`.

## Dokumentacja

Zobacz [PLAN.md](../PLAN.md).
