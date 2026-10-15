// View mutations, and the board-view dashboards built on them, need API 2026-10; everything else
// stays on the client's pinned version. Lives here so index.ts and overviews.ts can share it
// without an import cycle.
export const VIEW_API_VERSION = '2026-10';
