# Deploy — MapMold jako dodatkowy serwer

Aplikacja jest SPA (Vite). Możesz ją włączać i wyłączać jako osobny serwer.

## A) Panel CloudHosting nazwa.pl (halaba.online)

1. Zbuduj lokalnie:
   ```bash
   cd web && npm ci && npm run build
   ```
2. Wrzuć na hosting (FTP/SFTP) do katalogu aplikacji, np. `mapmold/`:
   - `deploy/nazwa/app.js` (jako `app.js` w katalogu docelowym)
   - cały katalog `web/dist/` → `dist/` obok `app.js`
   - **nie** wgrywaj `web/package.json` z `"type":"module"` do tego katalogu
3. W **CloudHosting Panel / Active.admin**:
   - dodaj subdomenę np. `mapmold.halaba.online` → katalog z `app.js`
   - ustaw **interpreter Node.js** (nie PHP)
   - wybierz wersję Node (najlepiej aktualne LTS)
4. **Włączenie**: interpreter Node.js ON dla tej domeny  
   **Wyłączenie**: przełącz z powrotem na PHP / wyłącz Node dla domeny (albo usuń subdomenę)

Healthcheck: `https://mapmold.halaba.online/health` → `{"ok":true,"service":"mapmold"}`

## B) Docker (własny VPS / panel z compose)

```bash
# start (profil mapmold)
docker compose --profile mapmold up -d --build mapmold

# stop
docker compose --profile mapmold stop mapmold

# całkowite wyłączenie
docker compose --profile mapmold down
```

Domyślny port hosta: `3080` (nadpisz `MAPMOLD_PORT=…`).

## C) Preview lokalny (bez Dockera)

```bash
cd web && npm run build && STATIC_ROOT=dist node app.js
```

## Uwagi

- Overpass (OSM) i kafelki mapy lecą z przeglądarki użytkownika — serwer tylko serwuje pliki.
- Tunel Cloudflare z sesji agenta jest tymczasowy; produkcja = A lub B powyżej.
