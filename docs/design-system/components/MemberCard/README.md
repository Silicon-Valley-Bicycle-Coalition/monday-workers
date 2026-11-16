# MemberCard
A wallet-style membership card shown on the donor dashboard: wordmark, QR code, name, expiry and tier.

- Always dark in both themes: a 135° gradient `card-mid` → `svbc-black` → `card-deep`, a faint gold radial glow, `radius-card`, `shadow-card`.
- 340px max, `aspect-ratio: 340/214`, so it scales down instead of overflowing.
- QR sits on a `card-deep` plate with a 35%-gold inset ring, 77px square. The consumer supplies the QR SVG (generated per card token by `card/qr.ts`).
- Name: style `card-name`. Labels: `card-label` uppercase in `chrome-muted`; values 13px `svbc-white`. Tier: gold `tier-badge` pill.
- The "Get a new code" link uses `link-quiet`, which is only 3.5:1 on white — flagged, kept as the source has it.
