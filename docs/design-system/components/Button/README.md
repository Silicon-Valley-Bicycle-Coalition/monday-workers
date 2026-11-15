# Button
Every button is a full pill (`radius-pill`, 300px), as on bikesiliconvalley.org: gold primary, outline secondary.

| Look | Markup | Tokens |
| --- | --- | --- |
| Primary | `main button[type=submit]`, `.btn-primary`, `a.cta-button` | `svbc-gold` fill, `svbc-black` text, Poppins 16px **400**, padding `space-4` × `button-pad-x` |
| Outline (light ground) | `button` | transparent, 1px `text` border and text, 600 weight — the website's "Sign Up For Our Newsletter" |
| Outline (dark ground) | `.btn-secondary`, `.logout-form button` | transparent, `svbc-gold` border and text, 600 |
| Donate | `a.site-header-donate` | the primary pill in the header — always present on the website and portal |

- Gold means "the one thing to do here". One gold action per view (Donate in the header doesn't count).
- Focus: 2px `svbc-gold` outline, 2px offset.
