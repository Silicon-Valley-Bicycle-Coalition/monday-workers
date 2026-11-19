import { describe, it, expect } from 'vitest';
import { checkEmailView, errorView, loginFormView, page } from './views';
import { t } from './i18n/t';

describe('page', () => {
  it('loads nothing from another origin: fonts come from the portal stylesheet (#123)', () => {
    const html = page('Title', '<p>body</p>', 'en', { authenticated: true });
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(html).not.toMatch(/<(link|script|img)\b[^>]*\b(href|src)="https?:/);
  });

  it('wraps the body in a document with charset, viewport, the given title, and the locale as <html lang>', () => {
    const html = page('Check Your Email — SVBC Member Portal', '<h1>Check your email</h1>', 'es');
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<title>Check Your Email — SVBC Member Portal</title>');
    expect(html).toContain('<h1>Check your email</h1>');
  });

  it('escapes a title containing markup', () => {
    const html = page('<script>alert(1)</script>', '<p>body</p>', 'en');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders the shared site header with the SVBC wordmark on every page', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('class="site-header"');
    expect(html).toContain('class="site-logo"');
  });

  it('omits the logout button by default (pre-identity and public pages)', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).not.toContain('action="/logout"');
  });

  it('shows a logout button in the header when authenticated', () => {
    const html = page('Title', '<p>body</p>', 'en', { authenticated: true });
    expect(html).toContain('action="/logout"');
    expect(html).toContain(t('en', 'portal.logout'));
  });

  it('links the header logo to the org website, opening in a new tab', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('class="site-header-logo-link" href="https://bikesiliconvalley.org" target="_blank"');
  });

  it('shows a gold Donate button in the header linking to the ways-to-give page', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('class="site-header-donate" href="https://bikesiliconvalley.org/ways-to-give"');
    expect(html).toContain(t('en', 'nav.donate'));
  });

  it('renders a footer with basic org contact information, on every page', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('class="site-footer"');
    expect(html).toContain('Silicon Valley Bicycle Coalition');
    expect(html).toContain('95 S Market St, Suite 648, San José, CA 95113');
    expect(html).toContain('href="https://bikesiliconvalley.org"');
  });

  it('renders the org\'s nonprofit status, EIN, and mailing address in the footer', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain(t('en', 'footer.nonprofit'));
    expect(html).toContain('77-0338658');
    expect(html).toContain(t('en', 'footer.mailingAddress'));
    expect(html).toContain('PO Box 1927, San José, CA 95109');
  });

  it('links to the privacy policy in the footer, opening in a new tab', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain(
      'href="https://siliconvalleybicyclecoaliti.app.box.com/s/1diyqeoe5dcsfsg0qx2yk7oa539toz35" target="_blank"'
    );
    expect(html).toContain(t('en', 'footer.privacyPolicy'));
  });

  it('renders a footer language switcher offering every supported locale, auto-submitting on change', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('class="site-footer-lang" action="/lang" method="get"');
    expect(html).toContain('<option value="es">');
    expect(html).toContain('<option value="vi">');
    expect(html).toContain('<option value="en" selected>');
    // Auto-submits on select, filling `to` with the browser's actual current path and query so
    // switching language returns the visitor to wherever they were, without page() needing to
    // know it. The query matters: the sign-in page's ?next= (return-to after sign-in) lives there.
    expect(html).toContain(`onchange="this.form.to.value = location.pathname + location.search; this.form.submit()"`);
  });

  // Distinct from LOCALE_LABELS (the English names round-tripped through Monday's Preferred
  // Language column) — this picker shows each language's own name, so a visitor recognizes
  // theirs even while the page is rendered in a language they don't read.
  it('labels each language option in its own language, not English', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('<option value="es">Español</option>');
    expect(html).toContain('<option value="ja">日本語</option>');
    expect(html).toContain('<option value="vi">Tiếng Việt</option>');
    expect(html).not.toContain('>Spanish<');
    expect(html).not.toContain('>Japanese<');
  });
});

describe('loginFormView', () => {
  it('renders an H1 with just "Member Portal", not the full SVBC-prefixed site title', () => {
    const html = loginFormView('en');
    expect(html).toContain('<h1>Member Portal</h1>');
  });

  it('renders a form posting to / with an email field', () => {
    const html = loginFormView('en');
    expect(html).toContain('action="/"');
    expect(html).toContain('name="email"');
    expect(html).toContain('Send login link');
  });

  it('renders the prompt in the requested locale when translated (fallback to English otherwise)', () => {
    const html = loginFormView('en');
    expect(html).toContain('Enter your email to receive a login link.');
  });

  it('renders actual translated copy for a non-English locale, not just structure', () => {
    const html = loginFormView('es');
    expect(html).toContain(t('es', 'login.prompt'));
  });
});

describe('checkEmailView', () => {
  it('renders the same generic message regardless of caller state', () => {
    const html = checkEmailView('en');
    expect(html).toContain('check your email');
  });

  it('renders actual translated copy for a non-English locale, not just structure', () => {
    const html = checkEmailView('es');
    expect(html).toContain(t('es', 'checkEmail.heading'));
  });
});

describe('errorView', () => {
  it('renders the message for the given translation key, escaped', () => {
    const html = errorView('error.invalidLink', 'en');
    expect(html).toContain('This link is invalid');
  });

  it('links back to / for a new link', () => {
    const html = errorView('error.invalidLink', 'en');
    expect(html).toContain('href="/"');
  });

  it('renders actual translated copy for a non-English locale, not just structure', () => {
    const html = errorView('error.invalidLink', 'es');
    expect(html).toContain(t('es', 'error.invalidLink'));
  });
});
