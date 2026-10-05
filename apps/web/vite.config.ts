import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The game lives at beachbingo.xyz/app/: the landing page has the site root and the
// multiplayer rooms have /play/. Every URL the build writes, the manifest's scope and the
// service worker's scope start with this, so the game never caches or controls those pages.
const BASE = '/app/';

// https://vite.dev/config/
export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icons/*.png'],
      manifest: {
        id: BASE,
        name: 'Beach Bingo',
        short_name: 'Beach Bingo',
        description: 'Provably fair island bingo: a 40-level island adventure, bingo halls and quick games. Free to play with shells.',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#1fb5a8',
        theme_color: '#1fb6e8',
        categories: ['games', 'entertainment'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  server: { port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
