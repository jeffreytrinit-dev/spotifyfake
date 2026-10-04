import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Workspace TS sources are bundled; real npm packages stay external (installed in the image).
  noExternal: ['@tidepool/shared'],
});
