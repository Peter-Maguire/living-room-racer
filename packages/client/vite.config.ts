import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  // The client reads its config from these at build/runtime; populated by
  // infra/scripts/outputs.sh into packages/client/.env.
  envPrefix: 'VITE_',
});
