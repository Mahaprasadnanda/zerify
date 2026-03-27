import { defineConfig } from 'vite';

export default defineConfig({
  // Served behind Next.js/Nginx under /prover/
  base: '/prover/',
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
