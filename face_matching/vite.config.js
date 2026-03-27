import { defineConfig } from 'vite';

export default defineConfig({
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
