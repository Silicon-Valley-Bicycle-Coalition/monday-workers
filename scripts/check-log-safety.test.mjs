import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations, maskLiterals } from './check-log-safety.mjs';

const names = (source) => findViolations(source).map((v) => v.name);

describe('findViolations', () => {
  it('flags an email-ish identifier in a template expression', () => {
    assert.deepEqual(names('console.error(`failed for "${email}": ${errMsg}`);'), ['email']);
  });

  it('flags a property access and an address field across lines', () => {
    assert.deepEqual(names('console.warn(\n  `no match for ${contactEvent.email}`,\n  params.to,\n);'), ['email', '.to']);
  });

  it('flags a recipients array passed as an object value', () => {
    assert.deepEqual(names("console.log(JSON.stringify({ originalTo: originalRecipients }));"), ['originalRecipients']);
  });

  it('ignores string and template text', () => {
    assert.deepEqual(names('console.error(`no email on file for donor "${row.donorItemId}"`, "email: x");'), []);
  });

  it('ignores anything inside an allowed wrapper, even nested', () => {
    assert.deepEqual(names('console.error(`member ${memberId(event.email)}: ${redactEmails(fmt(email))} ${errorText(e)}`);'), []);
  });

  it('ignores a .length read and an object key', () => {
    assert.deepEqual(names('console.log(JSON.stringify({ recipients: originalRecipients.length }));'), []);
  });

  it('ignores email-ish names outside console calls, and method calls like .to()', () => {
    assert.deepEqual(names('const email = x.email;\nsend(email);\nconsole.log(expect(a).to(b));'), []);
  });

  it('honours a suppress comment on the line above', () => {
    assert.deepEqual(names('// log-safety: allow — local dev only\nconsole.log(params.to);'), []);
  });

  it('is not thrown off by a regex literal containing quotes', () => {
    const source = "const P = /[^\\s\"'<>]+@x/g;\nconsole.error(`for ${email}`);";
    assert.deepEqual(findViolations(source), [{ line: 2, name: 'email' }]);
  });
});

describe('maskLiterals', () => {
  it('blanks literal text and comments but keeps offsets and template expressions', () => {
    const source = 'a("x@y.co", `t ${b} u`) // c@d.co';
    const masked = maskLiterals(source);
    assert.equal(masked.length, source.length);
    assert.ok(!masked.includes('@'));
    assert.ok(masked.includes('${b}'));
  });
});
