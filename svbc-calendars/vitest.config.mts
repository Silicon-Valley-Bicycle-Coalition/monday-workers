import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig, defineProject } from "vitest/config";

export default defineConfig(
  defineProject({
    // The `ics` npm package (used by src/ics.ts, Task 6) depends on yup, nanoid, and runes2,
    // each shipped as dual CJS/ESM packages. @cloudflare/vitest-pool-workers' module-fallback
    // resolver disables CJS/ESM interop for modules reached via CJS requires, which breaks when
    // it resolves their ESM builds instead of CJS:
    //  - yup has no "exports" map, just "main"/"module" fields; forcing `mainFields: ['main']`
    //    makes it resolve yup's real CJS entry, which requires property-expr without interop.
    //  - nanoid and runes2 both declare an "exports" map, which takes precedence over mainFields;
    //    aliasing them straight to their real CJS entry points sidesteps that.
    resolve: {
      mainFields: ["main"],
      alias: {
        nanoid: path.join(import.meta.dirname, "node_modules/nanoid/index.cjs"),
        runes2: path.join(import.meta.dirname, "node_modules/runes2/dist/index.cjs"),
      },
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
      }),
    ],
  })
);
