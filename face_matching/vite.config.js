import { defineConfig } from 'vite';

export default defineConfig({
  // Served behind Nginx under a dedicated static path to avoid clashing with
  // the Next.js prover launcher route at /prover.
  base: '/prover-app/',
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
