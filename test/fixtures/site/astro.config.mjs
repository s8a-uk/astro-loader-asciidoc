// Site used by the E2E tests.
// The tests point the output and cache directories at temporary directories, so that no build
// output is left in the repository
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  markdown: {
    shikiConfig: { theme: 'nord' },
  },
  ...(process.env.E2E_OUT_DIR ? { outDir: process.env.E2E_OUT_DIR } : {}),
  ...(process.env.E2E_CACHE_DIR ? { cacheDir: process.env.E2E_CACHE_DIR } : {}),
});
