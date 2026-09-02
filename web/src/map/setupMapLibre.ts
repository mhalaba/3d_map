import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// MapLibre v6: bundlers must set the worker URL before creating a Map.
setWorkerUrl(workerUrl);
