import { describe, it, expect } from 'vitest';
import { renderEmailLayout } from './layout';

const LOGO_URL = 'https://member.bikesiliconvalley.org/email/logo.png';

describe('renderEmailLayout', () => {
  it('embeds the caller-provided body HTML and text verbatim', () => {
    const result = renderEmailLayout({ bodyHtml: '<p>Hello donor</p>', bodyText: 'Hello donor', logoUrl: LOGO_URL });
    expect(result.html).toContain('<p>Hello donor</p>');
    expect(result.text).toContain('Hello donor');
  });

  it('references the logo by absolute URL', () => {
    const result = renderEmailLayout({ bodyHtml: '<p>x</p>', bodyText: 'x', logoUrl: LOGO_URL });
    expect(result.html).toContain(`src="${LOGO_URL}"`);
  });

  it('includes the org footer in both parts', () => {
    const result = renderEmailLayout({ bodyHtml: '<p>x</p>', bodyText: 'x', logoUrl: LOGO_URL });
    expect(result.html).toContain('Silicon Valley Bicycle Coalition');
    expect(result.text).toContain('Silicon Valley Bicycle Coalition');
  });

  it('declares light/dark color-scheme support and dark-mode overrides', () => {
    const result = renderEmailLayout({ bodyHtml: '<p>x</p>', bodyText: 'x', logoUrl: LOGO_URL });
    expect(result.html).toContain('name="color-scheme" content="light dark"');
    expect(result.html).toContain('@media (prefers-color-scheme: dark)');
  });

  it('keeps the header band dark regardless of color scheme, since the logo only reads on dark', () => {
    const result = renderEmailLayout({ bodyHtml: '<p>x</p>', bodyText: 'x', logoUrl: LOGO_URL });
    expect(result.html).toContain('background:#000000');
    // The dark-mode override block (inside <style>) must not touch the header's background.
    const styleBlock = result.html.slice(result.html.indexOf('<style>'), result.html.indexOf('</style>'));
    expect(styleBlock).toContain('@media (prefers-color-scheme: dark)');
    expect(styleBlock).not.toContain('#000000');
  });
});
