import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Standalone marketing site. Physically isolated from the runtime dashboard
// (dashboard/) and never published to npm (see root package.json "files").
export default defineConfig({
  // '/' for local dev & custom domains; '/pikiclaw/' for the GitHub Pages
  // project site (set VITE_BASE=/pikiclaw/ in the deploy build).
  base: process.env.VITE_BASE || '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // @lobehub/icons pulls in CJS deps (hoist-non-react-statics) that Vite's dev
  // ESM loader can't interop on its own — force pre-bundling so dev matches prod.
  optimizeDeps: {
    include: ['@lobehub/icons', 'hoist-non-react-statics'],
  },
});
