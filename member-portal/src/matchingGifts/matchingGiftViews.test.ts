import { describe, it, expect } from 'vitest';
import { matchingGiftsView } from './matchingGiftViews';

describe('matchingGiftsView', () => {
  it('renders the generic guidance with no widget when no key is configured', () => {
    const html = matchingGiftsView({ publicApiKey: null, ein: null }, 'en');
    expect(html).toContain('Employer matching gifts');
    expect(html).toContain('An employer search will appear here once it is set up.');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('doublethedonation.com');
  });

  it('embeds the DTD widget when a public key is configured', () => {
    const html = matchingGiftsView({ publicApiKey: 'dtd-abc123', ein: null }, 'en');
    expect(html).toContain('<script src="https://doublethedonation.com/api/js/ddplugin.js"></script>');
    expect(html).toContain('id="dd-shadow-container"');
    expect(html).toContain('doublethedonation.plugin.v2.load_plugin(shadow_container, "dtd-abc123", { isolated: true });');
    expect(html).toContain('<a href="https://doublethedonation.com">');
    expect(html).toContain('https://doublethedonation.com/api/img/powered-by.png');
    expect(html).not.toContain('DDCONF');
    expect(html).toContain('Search for your employer below');
  });

  it('cannot be broken out of by a hostile key value', () => {
    const html = matchingGiftsView({ publicApiKey: '</script><script>alert(1)', ein: null }, 'en');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('shows the EIN line only when the EIN is signed off', () => {
    const withEin = matchingGiftsView({ publicApiKey: null, ein: '00-0000000' }, 'en');
    expect(withEin).toContain('00-0000000');
    const withoutEin = matchingGiftsView({ publicApiKey: null, ein: null }, 'en');
    expect(withoutEin).not.toContain('tax ID (EIN)');
  });
});
