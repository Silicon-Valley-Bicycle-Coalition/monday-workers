# EmailLayout
The branded wrapper for every outbound email: dark header band with the PNG wordmark, white card, muted footer.

- Production HTML is table-based with inline styles (`renderEmailLayout()` in member-portal, bp-feedback-notify, report-digests; a hand-pasted copy for Monday automations in `docs/email-branding/`). This preview is a token-bound rendition.
- Header band is `svbc-black` in every client and scheme: the PNG wordmark (`svbc-wordmark-email.png`, 470px for 235px display) is white/gold and only reads on dark.
- Wrap `email-wrap`, card `email-card`, body `email-text` 16px/1.5, footer `text-muted` 12px, `radius-lg` corners, 560px (`email-max`).
- Dark mode is a `prefers-color-scheme` block with `!important` overrides — best effort; clients that strip `<style>` show light mode, which still reads correctly.
- The caller escapes every untrusted value in `bodyHtml`; always send a plain-text part too.
