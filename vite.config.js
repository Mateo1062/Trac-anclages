import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'icon.svg'],
      manifest: {
        name: "Traç'Anclages",
        short_name: "Traç'Anclages",
        description: 'Gestion agricole complète — planning, stockage, traçabilité',
        start_url: '/',
        display: 'standalone',
        background_color: '#17293D',
        theme_color: '#17293D',
        orientation: 'any',
        lang: 'fr',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json,webmanifest}'],
        navigateFallback: '/index.html',
        // Gestion des notifications push (rappels de factures) — voir public/sw-push.js.
        importScripts: ['sw-push.js'],
        // Polices Google Fonts chargées depuis un CDN externe (index.html) — mises en
        // cache après le premier chargement en ligne pour rester lisibles hors-ligne
        // (sinon fallback silencieux sur une police système, pas bloquant mais moins soigné).
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
})
