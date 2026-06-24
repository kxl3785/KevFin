import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      // Defaults to the local dev server; override (e.g. for a demo instance on
      // another port) with API_PROXY=http://localhost:3055.
      '/api': process.env.API_PROXY || 'http://localhost:3001',
    },
  },
});
