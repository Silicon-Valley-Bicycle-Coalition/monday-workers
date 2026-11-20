# Zoom Phone webhook fixtures — provisional

**Synthetic, not captured.** These follow the design's reading of Zoom's events reference
(`docs/superpowers/specs/2026-11-19-zoom-phone-sync-design.md`, "Fields used"). #50 replaces them
with real sandbox deliveries (numbers, names and message text replaced); the SMS fields especially
are unconfirmed. All numbers are in the fictional 555-01xx range; all names and ids are made up.

To replace them: save each raw delivery as JSON and run
`node scripts/redact-capture.mjs <capture.json>... --out test/fixtures`. It replaces names, numbers
(with 555-01xx stand-ins), emails, ids and message text, consistently across files, and lists any
string it kept because no rule matched — check those by hand before committing.
