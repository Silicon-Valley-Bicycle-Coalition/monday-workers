// Per-request bound on every upstream source fetch (#73). A hung source would otherwise hold an
// .ics cache MISS open (blocking the KV fallback that should answer it) and stall the daily cron's
// loop over every source. Same bound as the Slack alert in alert.ts; a timeout throws, which the
// callers already treat as a failed fetch (fallback served, failure streak counted).
export const SOURCE_FETCH_TIMEOUT_MS = 10_000;
