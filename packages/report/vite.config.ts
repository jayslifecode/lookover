import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/*
 * The report is built to static files the CLI serves from any path (`base: './'`).
 */

/**
 * React's and Base UI's production error messages name a documentation page
 * (`https://react.dev/errors/<code>`, `https://base-ui.com/production-error?code=…`). Nothing is loaded
 * from there, but the built report carries no external address at all (test/built-report.test.ts), so
 * the build writes these without the scheme; the message still says where to look.
 */
const VENDOR_ERROR_PAGES = ['https://react.dev/errors/', 'https://base-ui.com/production-error'];

function unlinkVendorErrorPages(): Plugin {
  return {
    name: 'lookover-unlink-vendor-error-pages',
    apply: 'build',
    renderChunk(code) {
      const next = VENDOR_ERROR_PAGES.reduce(
        (text, page) => text.replaceAll(page, page.replace(/^https:\/\//, '')),
        code,
      );
      return next === code ? null : { code: next, map: null };
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), unlinkVendorErrorPages()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
