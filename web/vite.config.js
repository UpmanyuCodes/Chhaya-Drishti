import { defineConfig } from 'vite';

// relative base so the built site works from any sub-path (GitHub Pages, etc.)
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  server: { host: '127.0.0.1', port: 5173 },
});
