import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Code shared across the REST boundary lives in the server package (single
    // source of truth): the API types (type-only, erased at build) and the
    // dependency-free assistant chart-spec validator, which is bundled here.
    alias: { '@shared': fileURLToPath(new URL('../server/src/shared', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      // Defaults to the local dev server; override (e.g. for a demo instance on
      // another port) with API_PROXY=http://localhost:3055.
      '/api': process.env.API_PROXY || 'http://localhost:3001',
    },
  },
});
