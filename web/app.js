/**
 * Zero-dependency static file server for MapMold (ESM — used with web/package.json).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.env.NODE_PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(__dirname, process.env.STATIC_ROOT || 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.stl': 'model/stl',
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control':
      code === 200 && type && type.includes('text/html') ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(body);
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split('?')[0]);
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, cleaned);
  if (!full.startsWith(root)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) {
    send(res, 405, 'Method Not Allowed');
    return;
  }

  if (req.url === '/health' || req.url === '/healthz') {
    send(
      res,
      200,
      JSON.stringify({ ok: true, service: 'mapmold', root: ROOT }),
      'application/json',
    );
    return;
  }

  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    send(res, 400, 'Bad Request');
    return;
  }

  let filePath = safeJoin(ROOT, pathname === '/' ? '/index.html' : pathname);
  if (!filePath) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        fs.readFile(path.join(ROOT, 'index.html'), (spaErr, html) => {
          if (spaErr) {
            send(res, 404, 'Not Found');
            return;
          }
          send(res, 200, html, MIME['.html']);
        });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      send(res, 200, data, MIME[ext] || 'application/octet-stream');
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`MapMold listening on http://${HOST}:${PORT} (static: ${ROOT})`);
});
