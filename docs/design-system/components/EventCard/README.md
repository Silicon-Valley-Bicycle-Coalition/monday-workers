# EventCard
One event in the Eventbrite calendar widget embedded on bikesiliconvalley.org: gold date badge, title with Free/Paid badge, meta rows, summary, Register.

- Lives inside the website's page, so it uses the website's tokens: `cal-accent` and `cal-dark` now alias `svbc-gold` and `svbc-ink`, title, day numeral and body in Nunito Sans, Register as the gold primary pill.
- `svbc-calendars/src/widget.ts` uses these values as of MR 478.
- Always light (white card); the widget does not theme for dark mode.
- Meta icons are 16px stroked line icons (calendar, clock, pin) in `cal-accent`, `stroke-width` 1.5.
- Summary clamps to 3 lines (4 in grid layout).
