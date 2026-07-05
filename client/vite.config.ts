import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Shared API types live in the server package (single source of truth for
    // both sides of the REST boundary). Type-only imports, erased at build.
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
