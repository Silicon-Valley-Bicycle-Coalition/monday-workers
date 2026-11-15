# Tabs
CSS-only tabs built from radio inputs and labels, so the portal needs no JavaScript.

- Order in the DOM: every `input.tab-input` immediately followed by its `label.tab-label`, then the `div.tab-panel`s in the same order. Supports up to three tabs (the `:nth-of-type` rules).
- Inactive label: `tab-bg` / `tab-border`. Active: `svbc-black` with `svbc-gold` text. Panel top rule: 2px `text`.
- Inputs stay in flow (1px, transparent), never `position:absolute`, so assistive tech and the keyboard reach them; focus shows a gold ring on the label.
- Empty panel: `.tab-empty` with a sentence and a `.cta-button`.
- Print shows every panel and hides the labels.
