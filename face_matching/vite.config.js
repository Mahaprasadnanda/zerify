import { defineConfig } from 'vite';

export default defineConfig({
  // Deployed as a standalone Cloudflare Pages site.
  base: '/',
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  server: {
    host: true,
    port: 3010,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
});
