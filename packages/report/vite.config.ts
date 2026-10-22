import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { mockApi } from './dev/mock-api.ts';

/*
 * The report is built to static files the CLI serves from any path (`base: './'`). In development the
 * mock API plugin serves the fixture run under the same HTTP contract the CLI's server implements.
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), mockApi()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
