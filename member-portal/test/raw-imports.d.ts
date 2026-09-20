// Vite serves `?raw` imports as the file's text. Used by config/split.test.ts to read
// wrangler.jsonc inside the Workers test runtime, where node:fs is unavailable.
declare module '*?raw' {
  const text: string;
  export default text;
}
