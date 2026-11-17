// Vite serves `?raw` imports as the file's text, and `import.meta.glob` lists files at build time.
// config/coverage.test.ts uses both to read every Worker's wrangler.jsonc inside the test runtime,
// where node:fs is unavailable. Adapted from member-portal/test/raw-imports.d.ts.
declare module '*?raw' {
  const text: string;
  export default text;
}

interface ImportMeta {
  glob(pattern: string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
}
