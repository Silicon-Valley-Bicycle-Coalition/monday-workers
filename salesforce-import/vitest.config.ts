import { defineConfig } from 'vitest/config';

// Tests are *.test.ts only: src/configure/overviews.spec.ts is a data module (the Overview spec
// table), not a test file, and vitest's default glob would otherwise try to run it.
export default defineConfig({
  test: { include: ['**/*.test.ts'] },
});
