// Vite serves `?raw` imports as the file's text. Used by config/split.test.ts to read
// wrangler.jsonc inside the test runtime, where node:fs is unavailable. Copied from
// member-portal/test/raw-imports.d.ts.
declare module '*?raw' {
  const text: string;
  export default text;
}
