import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EMAILS, OUTPUT_DIR, renderEmail } from './build-stewardship-emails.mjs';

const SEQUENCES = ['Welcome: day after', 'Welcome: 3 weeks', 'Renewal: 3 weeks before', 'Renewal: 1 week before', 'Renewal: day of'];
const count = (text, part) => text.split(part).length - 1;

test('covers the five Sequences, in order', () => {
  assert.deepEqual(EMAILS.map((email) => email.sequence), SEQUENCES);
});

for (const email of EMAILS) {
  test(`${email.sequence}: the committed file is up to date`, () => {
    assert.equal(readFileSync(new URL(`${email.slug}.html`, OUTPUT_DIR), 'utf8'), `${renderEmail(email)}\n`);
  });

  test(`${email.sequence}: one unsubscribe link, in the form Monday fills in`, () => {
    const html = renderEmail(email);
    assert.equal(count(html, 'data-unsubscribe="true"'), 1);
    assert.equal(count(html, '>Unsubscribe from member emails</a>'), 1);
    assert.match(html, /<a class="crm-composer-unsubscribe-link-anchor-element" href="#"/);
  });

  test(`${email.sequence}: merges First Name, and only columns this email needs`, () => {
    const columns = [...renderEmail(email).matchAll(/\{pulse\.(\w+)\}/g)].map((match) => match[1]);
    const extra = { 'welcome-day-after': ['numeric_mm8pd89h'], 'welcome-3-weeks': [] }[email.slug] ?? ['date_mm8n6xgb'];
    assert.deepEqual(columns, ['text_mm8scaqj', ...extra]);
  });

  test(`${email.sequence}: every site link carries the email's own campaign`, () => {
    const links = [...renderEmail(email).matchAll(/href="(https:[^"]*)"/g)].map((match) => match[1]);
    assert.ok(links.length > 0);
    for (const link of links) {
      assert.ok(link.startsWith('https://bikesiliconvalley.org/'), link);
      assert.ok(link.endsWith(`?utm_source=monday&amp;utm_medium=email&amp;utm_campaign=${email.campaign}`), link);
    }
  });
}

test('every image has alt text', () => {
  for (const email of EMAILS) {
    const images = renderEmail(email).match(/<img [^>]*>/g);
    assert.equal(images.length, 2);
    for (const image of images) assert.match(image, / alt="[^"]+"/);
  }
});
