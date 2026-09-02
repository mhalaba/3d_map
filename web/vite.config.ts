import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Allow serving the dev/preview server through Cloudflare quick tunnels
// (`*.trycloudflare.com`) so a live build can be shared with others.
const allowedHosts = ['.trycloudflare.com'];

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  worker: {
    format: 'es',
  },
  server: {
    allowedHosts,
  },
  preview: {
    allowedHosts,
  },
});
