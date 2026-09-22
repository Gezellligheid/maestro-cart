import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 3200, // Rapier ships its WASM inlined as base64 (~2.8 MB, ~1.1 MB gzipped)
    rollupOptions: {
      output: {
        // Split heavy vendors so the app chunk stays small and caches well on Vercel's CDN.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('three')) return 'three';
          if (id.includes('rapier')) return 'rapier';
          if (id.includes('peerjs')) return 'peerjs';
          return 'vendor';
        },
      },
    },
  },
});
