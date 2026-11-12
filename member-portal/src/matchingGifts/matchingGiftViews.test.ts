import { describe, it, expect } from 'vitest';
import { matchingGiftsSearchDocument, matchingGiftsView, SEARCH_DOCUMENT_CSP, SEARCH_SANDBOX_FLAGS } from './matchingGiftViews';

describe('matchingGiftsView', () => {
  it('renders the generic guidance with no widget when no key is configured', () => {
    const html = matchingGiftsView({ publicApiKey: null, ein: null }, 'en');
    expect(html).toContain('Employer matching gifts');
    expect(html).toContain('An employer search will appear here once it is set up.');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('doublethedonation.com');
  });

  it('frames the sandboxed search document, never the DTD script, when a public key is configured', () => {
    const html = matchingGiftsView({ publicApiKey: 'dtd-abc123', ein: null }, 'en');
    expect(html).toContain('src="/en/portal/matching-gifts/search"');
    expect(html).toContain(`sandbox="${SEARCH_SANDBOX_FLAGS}"`);
    expect(html).toContain('title="Employer matching-gift search"');
    expect(html).toContain('Search for your employer below');
    // Issue #102: third-party JS must not run on the portal origin.
    expect(html).not.toContain('ddplugin.js');
    expect(html).not.toContain('dtd-abc123');
  });

  it('only accepts height reports from its own frame', () => {
    const html = matchingGiftsView({ publicApiKey: 'dtd-abc123', ein: null }, 'en');
    expect(html).toContain('event.source !== frame.contentWindow');
  });
});

describe('matchingGiftsSearchDocument', () => {
  it('embeds the DTD widget with the configured key', () => {
    const html = matchingGiftsSearchDocument('dtd-abc123', 'en');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<script src="https://doublethedonation.com/api/js/ddplugin.js"></script>');
    expect(html).toContain('id="dd-shadow-container"');
    expect(html).toContain('doublethedonation.plugin.v2.load_plugin(shadow_container, "dtd-abc123", { isolated: true });');
    expect(html).toContain('https://doublethedonation.com/api/img/powered-by.png');
    expect(html).toContain('ddSearchHeight');
    expect(html).not.toContain('DDCONF');
  });

  it('cannot be broken out of by a hostile key value', () => {
    const html = matchingGiftsSearchDocument('</script><script>alert(1)', 'en');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });
});

describe('SEARCH_DOCUMENT_CSP', () => {
  it('sandboxes the document into an opaque origin with the same flags as the iframe', () => {
    expect(SEARCH_DOCUMENT_CSP.startsWith(`sandbox ${SEARCH_SANDBOX_FLAGS};`)).toBe(true);
    expect(SEARCH_SANDBOX_FLAGS).not.toContain('allow-same-origin');
    expect(SEARCH_SANDBOX_FLAGS).not.toContain('allow-forms');
    expect(SEARCH_SANDBOX_FLAGS).not.toContain('allow-top-navigation');
  });

  it("only lets the portal frame it and blocks form posts", () => {
    expect(SEARCH_DOCUMENT_CSP).toContain("frame-ancestors 'self'");
    expect(SEARCH_DOCUMENT_CSP).toContain("form-action 'none'");
    expect(SEARCH_DOCUMENT_CSP).toContain("default-src 'none'");
  });
});

describe('matchingGiftsView (EIN)', () => {
  it('shows the EIN line only when the EIN is signed off', () => {
    const withEin = matchingGiftsView({ publicApiKey: null, ein: '00-0000000' }, 'en');
    expect(withEin).toContain('00-0000000');
    const withoutEin = matchingGiftsView({ publicApiKey: null, ein: null }, 'en');
    expect(withoutEin).not.toContain('tax ID (EIN)');
  });
});
