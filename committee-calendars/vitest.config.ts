import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig, defineProject } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

  return defineProject({
    // The `ics` npm package (used by src/ics.ts, Task 9) depends on yup, nanoid, and runes2,
    // each shipped as dual CJS/ESM packages. `@cloudflare/vitest-plugin`'s module-fallback
    // resolver disables CJS/ESM interop shimming for any module reached via a CJS `require()`
    // call (assuming it's already plain CommonJS), which breaks when the resolved file turns
    // out to be one of these packages' ESM builds:
    //  - yup has no "exports" map, just "main"/"module" fields, and the resolver was preferring
    //    "module" (its ESM entry) even for `require("yup")`; forcing `mainFields: ['main']`
    //    makes it resolve yup's real CJS entry, which requires plain-CJS `property-expr`
    //    without any interop being needed.
    //  - nanoid and runes2 both declare an "exports" map, which takes precedence over
    //    mainFields, and the resolver still picked non-CJS output for them under `require()`;
    //    aliasing them straight to their real CJS entry points sidesteps that.
    resolve: {
      mainFields: ['main'],
      alias: {
        nanoid: path.join(import.meta.dirname, 'node_modules/nanoid/index.cjs'),
        runes2: path.join(import.meta.dirname, 'node_modules/runes2/dist/index.cjs'),
      },
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      passWithNoTests: true,
    },
  });
});
