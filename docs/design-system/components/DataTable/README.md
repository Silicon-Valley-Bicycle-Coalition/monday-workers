# DataTable
The donation-history table: brand-black header row with gold text, striped body, bold total footer.

- `th`: `svbc-black` / `svbc-gold`, 6×10 padding. `td`: bottom rule `table-border`; even rows `row-stripe`.
- Money columns get `.col-amount` (right-aligned) on both `th` and `td`.
- `tfoot` total: bold, 2px `text` top rule.
- The table is `display:block; overflow-x:auto` so it scrolls instead of breaking narrow layouts.
