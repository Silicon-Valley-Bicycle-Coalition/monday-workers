# Affiliation Model, Plan 1 of 4: `salesforce-import` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `salesforce-import` emit the affiliation model — an Affiliations board with role,
status, dates, and a work email per tenure; People with Personal and Household emails (each with
its own consent status); and historical gifts and registrations attributed to the affiliation the
person acted for — so the sandbox load produces the board shape the three follow-on plans
(rollups, resolver, mailchimp-sync) build on.

**Architecture:** Pure transform work, no network, following the existing extract → transform →
load shape. New pure modules classify email domains (`emailKind.ts`), assign each Contact's
addresses to personal / household / work (`emails.ts`), build Affiliation payloads
(`affiliations.ts`), and attribute Opportunities and Registrations to affiliations plus compute
seed rollups (`attribution.ts`). `runTransform` wires them together and writes two review CSVs;
`load/boards.ts` learns the new columns, one new board, and renames the four People email columns
in place on existing sandbox boards. Everything else in the pipeline is untouched.

**Tech Stack:** Node 20+ ES modules, TypeScript strict (`noUncheckedIndexedAccess`), Vitest,
Monday.com GraphQL API (load only). Commands run from `salesforce-import/`.

**Spec:** [`docs/superpowers/specs/2026-09-08-person-org-email-model-design.md`](../specs/2026-09-08-person-org-email-model-design.md)

**Why four plans:** the spec covers four subsystems in a fixed order. This plan is the first;
each later one depends on board and column ids this one produces:
2. `donation-rollups`: per-affiliation and Organizational Giving recompute (spec "Rollups").
3. `impact-attribution` Worker: the email-first resolver and `email_index` (spec "The resolver").
4. `mailchimp-sync`: one Mailchimp contact per address (spec "Consent and mailchimp-sync").

## Global Constraints

- TypeScript strict mode with `noUncheckedIndexedAccess: true` (`tsconfig.json`); every task's code
  must typecheck with `npm run typecheck`.
- `transform` is pure: reads `data/extract/*.ndjson` and `data/enrich/*`, writes
  `data/transform/*` and `data/review/*`. No network calls in any transform module.
- Column **titles** are the contract between transform and load: every title a payload uses must
  have a `COLUMN_TYPES` entry in `src/load/boards.ts`, or load throws. Task 7 adds them; Tasks 5,
  6, and 8 introduce the titles. The test "every transform column title has a declared type"
  guards this.
- Consent vocabulary everywhere is exactly `Subscribed / Unsubscribed / Cleaned / Not in Mailchimp`.
  Affiliation Status vocabulary is exactly `Current / Former`. Attribution vocabulary is exactly
  `Auto / Staff / Needs review / None`.
- Emails are lowercased and trimmed at the edge (`collapseEmail` already does this); every map
  keyed by email uses the lowercased form.
- The Donor link on Donations and the Attendee link on Event Registrations do **not** change
  meaning. Attribution is additive ("Acting for"), never a re-pointing.
- Salesforce is read-only. The only new extract fields are on `npe5__Affiliation__c`.
- Conventional commits, one commit per task, in a worktree
  (`git worktree add ../monday-workers-affiliation-import -b feat/affiliation-import main`).

---

## File structure

| File | Responsibility |
|---|---|
| `src/extract/queries.ts` (modify) | affiliations SOQL gains dates, primary flag, description, provenance |
| `src/config.ts`, `config/svbc.json` (modify) | `consumerEmailDomains` list; `affiliations` board key |
| `src/transform/emailKind.ts` (create) | pure domain helpers: `emailDomain`, `websiteDomain`, `classifyDomain` |
| `src/transform/emails.ts` (create) | `assignEmails` (one Contact → personal / household / work map) and `parseEmailKindOverrides` |
| `src/transform/affiliations.ts` (create) | `affiliationToPayload`, `affiliationStatus`, `pickAffiliation` |
| `src/transform/attribution.ts` (create) | `AffiliationIndex`, `attributeOpportunity`, `attributeRegistration`, `attributionColumns`, `attributionRollups` |
| `src/transform/fields.ts` (modify) | `consentLabel` extracted; `consentColumns` emits the renamed People titles |
| `src/transform/people.ts` (modify) | renamed email columns, Household Primary, Affiliations link |
| `src/transform/donations.ts`, `src/transform/boards.ts` (modify) | `actingFor` on Opportunity and Registration payloads |
| `src/transform/index.ts` (modify) | wiring, review CSVs, report warnings |
| `src/load/boards.ts` (modify) | new column types / labels / connect targets, `affiliations` board label, in-place column renames |
| `src/load/index.ts` (modify) | `affiliations` in load order |
| `README.md` (modify) | run sequence, review files, board shape |

---

## Task 1: Extract the Affiliation fields the board needs

**Files:**
- Modify: `src/extract/queries.ts:524-525`
- Test: `src/extract/queries.test.ts` (create)

**Interfaces:**
- Produces: `data/extract/affiliations.ndjson` rows carrying `npe5__StartDate__c`,
  `npe5__EndDate__c`, `npe5__Primary__c`, `npe5__Description__c`, `CreatedDate`,
  `CreatedBy.Name`, `LastModifiedDate`, `LastModifiedBy.Name` in addition to the existing
  `Id`, `npe5__Contact__c`, `npe5__Organization__c`, `npe5__Role__c`, `npe5__Status__c`.

- [ ] **Step 1: Write the failing test**

```ts
// src/extract/queries.test.ts
import { describe, it, expect } from 'vitest';
import { buildExtracts } from './queries.js';
import { loadConfig } from '../config.js';

describe('buildExtracts', () => {
  it('pulls the Affiliation fields the Affiliations board needs', () => {
    const affil = buildExtracts(loadConfig()).find((e) => e.name === 'affiliations')!;
    const soql = affil.soql.replace(/\s+/g, ' ');
    for (const field of ['npe5__Role__c', 'npe5__Status__c', 'npe5__StartDate__c', 'npe5__EndDate__c',
      'npe5__Primary__c', 'npe5__Description__c', 'CreatedDate', 'CreatedBy.Name',
      'LastModifiedDate', 'LastModifiedBy.Name']) {
      expect(soql, field).toContain(field);
    }
    expect(affil.backupOnly).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/extract/queries.test.ts`
Expected: FAIL — `npe5__StartDate__c` not contained.

- [ ] **Step 3: Extend the SOQL**

Replace the `affiliations` entry in `src/extract/queries.ts`:

```ts
    { name: 'affiliations', soql: `SELECT Id, npe5__Contact__c, npe5__Organization__c, npe5__Role__c,
        npe5__Status__c, npe5__StartDate__c, npe5__EndDate__c, npe5__Primary__c, npe5__Description__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM npe5__Affiliation__c` },
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/extract/queries.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Confirm the fields are populated in the org (spec prerequisite)**

Run once against the live org (read-only; needs the sf CLI auth used by `extract`):

```bash
sf data query -o svbc --json -q "SELECT COUNT(Id) total, COUNT(npe5__StartDate__c) withStart, COUNT(npe5__EndDate__c) withEnd, COUNT(npe5__Primary__c) withPrimary FROM npe5__Affiliation__c"
```

Record the four numbers in the commit message. If `withStart` is under 10% of `total`, the
Start/End columns will import mostly blank and Status carries the load — that is acceptable and
expected; nothing in later tasks depends on dates being present.

- [ ] **Step 6: Commit**

```bash
git add src/extract/queries.ts src/extract/queries.test.ts
git commit -m "feat(salesforce-import): extract Affiliation dates, primary flag, and provenance

Live counts: <total> affiliations, <withStart> with StartDate, <withEnd> with EndDate, <withPrimary> primary."
```

---

## Task 2: Config — consumer email domains and the Affiliations board key

**Files:**
- Modify: `src/config.ts`, `config/svbc.json`
- Test: `src/config.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Produces: `Config.consumerEmailDomains: string[]` (optional in the interface, always present in
  `svbc.json`) and `cfg.monday.boards.affiliations` (null until provisioned, like every other key).

- [ ] **Step 1: Write the failing test**

```ts
// src/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('ships a consumer-mail domain list and an affiliations board key', () => {
    const cfg = loadConfig();
    expect(cfg.consumerEmailDomains).toContain('gmail.com');
    expect(cfg.consumerEmailDomains).toContain('comcast.net');
    expect('affiliations' in cfg.monday.boards).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — `consumerEmailDomains` undefined.

- [ ] **Step 3: Add the config**

In `src/config.ts`, add to the `Config` interface after `donationsActiveFiscalYears`:

```ts
  // Domains that mean "a person's own mailbox", never an organization's. A Secondary_Email__c on
  // one of these becomes Household Email; anything else that isn't an affiliated org's domain
  // goes to the human review file (see transform/emails.ts).
  consumerEmailDomains?: string[];
```

In `config/svbc.json`, add after `"donationsActiveFiscalYears": 2,`:

```json
  "consumerEmailDomains": [
    "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com", "live.com",
    "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "comcast.net", "sbcglobal.net",
    "att.net", "pacbell.net", "earthlink.net", "protonmail.com", "proton.me", "verizon.net",
    "sonic.net", "mindspring.com", "juno.com"
  ],
```

and add `"affiliations": null,` to `monday.boards` (after `"organizations": null,`).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/config.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts config/svbc.json
git commit -m "feat(salesforce-import): config for consumer email domains and the affiliations board"
```

---

## Task 3: `emailKind.ts` — pure domain classification

**Files:**
- Create: `src/transform/emailKind.ts`
- Test: `src/transform/emailKind.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function emailDomain(email: string | null | undefined): string | null;
  export function websiteDomain(url: string | null | undefined): string | null;
  export const DEFAULT_CONSUMER_DOMAINS: readonly string[];
  export type DomainKind = { kind: 'work'; orgSfId: string } | { kind: 'consumer' } | { kind: 'unknown' };
  export function classifyDomain(
    domain: string | null,
    candidateOrgIds: readonly string[],
    orgDomainByOrgId: ReadonlyMap<string, string>,
    consumerDomains: ReadonlySet<string>,
  ): DomainKind;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/transform/emailKind.test.ts
import { describe, it, expect } from 'vitest';
import { emailDomain, websiteDomain, classifyDomain, DEFAULT_CONSUMER_DOMAINS } from './emailKind.js';

describe('emailDomain', () => {
  it('lowercases and takes the part after @', () => {
    expect(emailDomain('Ada@Example.ORG')).toBe('example.org');
    expect(emailDomain(' ada@example.org ')).toBe('example.org');
  });
  it('is null for blank or malformed input', () => {
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain('')).toBeNull();
    expect(emailDomain('no-at-sign')).toBeNull();
    expect(emailDomain('trailing@')).toBeNull();
  });
});

describe('websiteDomain', () => {
  it('strips scheme, www, path, and port', () => {
    expect(websiteDomain('https://www.Acme.example/about')).toBe('acme.example');
    expect(websiteDomain('acme.example')).toBe('acme.example');
    expect(websiteDomain('http://acme.example:8080/')).toBe('acme.example');
  });
  it('is null for blank input', () => {
    expect(websiteDomain(null)).toBeNull();
    expect(websiteDomain('   ')).toBeNull();
  });
});

describe('classifyDomain', () => {
  const orgDomains = new Map([['org-acme', 'acme.example'], ['org-city', 'sanjoseca.gov']]);
  const consumer = new Set(DEFAULT_CONSUMER_DOMAINS);
  it('is work when the domain matches one of the candidate orgs', () => {
    expect(classifyDomain('acme.example', ['org-acme', 'org-city'], orgDomains, consumer))
      .toEqual({ kind: 'work', orgSfId: 'org-acme' });
  });
  it('matches subdomains of an org domain', () => {
    expect(classifyDomain('mail.sanjoseca.gov', ['org-city'], orgDomains, consumer))
      .toEqual({ kind: 'work', orgSfId: 'org-city' });
  });
  it('ignores org domains the person is not affiliated with', () => {
    expect(classifyDomain('acme.example', ['org-city'], orgDomains, consumer)).toEqual({ kind: 'unknown' });
  });
  it('is consumer for a known mailbox provider', () => {
    expect(classifyDomain('gmail.com', ['org-acme'], orgDomains, consumer)).toEqual({ kind: 'consumer' });
  });
  it('is unknown for anything else, including null', () => {
    expect(classifyDomain('startup.io', ['org-acme'], orgDomains, consumer)).toEqual({ kind: 'unknown' });
    expect(classifyDomain(null, ['org-acme'], orgDomains, consumer)).toEqual({ kind: 'unknown' });
  });
  it('prefers a work match over a consumer match if an org somehow uses a consumer domain', () => {
    const odd = new Map([['org-club', 'gmail.com']]);
    expect(classifyDomain('gmail.com', ['org-club'], odd, consumer)).toEqual({ kind: 'work', orgSfId: 'org-club' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/transform/emailKind.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/transform/emailKind.ts

// Which kind of mailbox an address is, judged by its domain alone. "Work" is only ever
// claimed for an organization the person is actually affiliated with — a stranger's
// company domain tells us nothing about *this* person.

export const DEFAULT_CONSUMER_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'comcast.net', 'sbcglobal.net',
  'att.net', 'pacbell.net', 'earthlink.net', 'protonmail.com', 'proton.me', 'verizon.net',
  'sonic.net', 'mindspring.com', 'juno.com',
];

export type DomainKind = { kind: 'work'; orgSfId: string } | { kind: 'consumer' } | { kind: 'unknown' };

export function emailDomain(email: string | null | undefined): string | null {
  const s = (email ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  return s.slice(at + 1);
}

export function websiteDomain(url: string | null | undefined): string | null {
  let s = (url ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // scheme
  s = s.split(/[/?#]/)[0] ?? '';                   // path, query, fragment
  s = s.split(':')[0] ?? '';                       // port
  s = s.replace(/^www\./, '');
  return s || null;
}

const matchesOrg = (domain: string, orgDomain: string): boolean =>
  domain === orgDomain || domain.endsWith(`.${orgDomain}`);

export function classifyDomain(
  domain: string | null,
  candidateOrgIds: readonly string[],
  orgDomainByOrgId: ReadonlyMap<string, string>,
  consumerDomains: ReadonlySet<string>,
): DomainKind {
  if (!domain) return { kind: 'unknown' };
  for (const orgSfId of candidateOrgIds) {
    const orgDomain = orgDomainByOrgId.get(orgSfId);
    if (orgDomain && matchesOrg(domain, orgDomain)) return { kind: 'work', orgSfId };
  }
  if (consumerDomains.has(domain)) return { kind: 'consumer' };
  return { kind: 'unknown' };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/transform/emailKind.test.ts && npm run typecheck`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transform/emailKind.ts src/transform/emailKind.test.ts
git commit -m "feat(salesforce-import): classify email domains as work, consumer, or unknown"
```

---

## Task 4: `emails.ts` — assign one Contact's addresses to personal / household / work

**Files:**
- Create: `src/transform/emails.ts`
- Test: `src/transform/emails.test.ts`

**Interfaces:**
- Consumes: `collapseEmail` (`fields.ts`), `emailDomain`, `classifyDomain` (Task 3).
- Produces:
  ```ts
  export interface AffiliationRef { sfId: string; orgSfId: string; primary: boolean }
  export interface EmailOverride { email: string; kind: 'personal' | 'household' | 'work'; affiliationSfId: string | null }
  export interface EmailAssignment {
    personal: string | null;
    household: string | null;
    work: Map<string, string>;          // affiliation sfId → address
    swapped: boolean;                    // primary and secondary traded places
    review: { email: string; domain: string }[];   // household by default, needs a human
  }
  export function parseEmailKindOverrides(csv: string): Map<string, EmailOverride>;
  export function assignEmails(
    contact: Record<string, unknown>,
    affiliations: readonly AffiliationRef[],
    orgDomainByOrgId: ReadonlyMap<string, string>,
    consumerDomains: ReadonlySet<string>,
    overrides: ReadonlyMap<string, EmailOverride>,
  ): EmailAssignment;
  ```

**Rules (from the spec's Migration §3):**
1. `primary` = `collapseEmail(contact)`; `secondary` = `Secondary_Email__c`, trimmed, lowercased.
2. An override for an address wins over domain classification.
3. Secondary: work → `work.set(affiliation, secondary)`; consumer → household; unknown →
   household **and** a review row.
4. Primary is Personal, except: primary is work and secondary is consumer → **swap** (personal =
   secondary, work gets primary, household = null, `swapped = true`). A work-domain primary with
   no consumer secondary stays Personal — it's the person's only usable address.
5. Primary never generates a review row.
6. Work match picks the affiliation flagged Primary first, else the first in input order.

- [ ] **Step 1: Write the failing tests**

```ts
// src/transform/emails.test.ts
import { describe, it, expect } from 'vitest';
import { assignEmails, parseEmailKindOverrides, type AffiliationRef } from './emails.js';
import { DEFAULT_CONSUMER_DOMAINS } from './emailKind.js';

const consumer = new Set(DEFAULT_CONSUMER_DOMAINS);
const orgDomains = new Map([['org-acme', 'acme.example'], ['org-city', 'sanjoseca.gov']]);
const atAcme: AffiliationRef = { sfId: 'af-acme', orgSfId: 'org-acme', primary: false };
const atCity: AffiliationRef = { sfId: 'af-city', orgSfId: 'org-city', primary: true };
const none = new Map();

describe('assignEmails', () => {
  it('personal primary + work secondary → work lands on that affiliation, no household', () => {
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'Ada@Acme.example' },
      [atAcme, atCity], orgDomains, consumer, none);
    expect(a.personal).toBe('ada@gmail.com');
    expect(a.household).toBeNull();
    expect(a.work.get('af-acme')).toBe('ada@acme.example');
    expect(a.swapped).toBe(false);
    expect(a.review).toEqual([]);
  });
  it('personal primary + consumer secondary → household', () => {
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'lovelaces@comcast.net' },
      [atAcme], orgDomains, consumer, none);
    expect(a.household).toBe('lovelaces@comcast.net');
    expect(a.work.size).toBe(0);
    expect(a.review).toEqual([]);
  });
  it('unknown-domain secondary → household plus a review row', () => {
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'ada@startup.io' },
      [atAcme], orgDomains, consumer, none);
    expect(a.household).toBe('ada@startup.io');
    expect(a.review).toEqual([{ email: 'ada@startup.io', domain: 'startup.io' }]);
  });
  it('work primary + consumer secondary → swap', () => {
    const a = assignEmails({ Email: 'ada@acme.example', Secondary_Email__c: 'ada@gmail.com' },
      [atAcme], orgDomains, consumer, none);
    expect(a.personal).toBe('ada@gmail.com');
    expect(a.work.get('af-acme')).toBe('ada@acme.example');
    expect(a.household).toBeNull();
    expect(a.swapped).toBe(true);
  });
  it('work primary with no consumer secondary stays personal (only address we have)', () => {
    const a = assignEmails({ Email: 'ada@acme.example' }, [atAcme], orgDomains, consumer, none);
    expect(a.personal).toBe('ada@acme.example');
    expect(a.work.size).toBe(0);
    expect(a.swapped).toBe(false);
  });
  it('a work match prefers the Primary-flagged affiliation', () => {
    const twice: AffiliationRef[] = [
      { sfId: 'af-city-old', orgSfId: 'org-city', primary: false },
      { sfId: 'af-city-new', orgSfId: 'org-city', primary: true },
    ];
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'ada@sanjoseca.gov' },
      twice, orgDomains, consumer, none);
    expect([...a.work.keys()]).toEqual(['af-city-new']);
  });
  it('an override wins over domain classification', () => {
    const overrides = parseEmailKindOverrides(
      'email,kind,affiliationSfId\nada@startup.io,work,af-acme\nada@gmail.com,household,\n');
    const a = assignEmails({ Email: 'ada@yahoo.com', Secondary_Email__c: 'ada@startup.io' },
      [atAcme], orgDomains, consumer, overrides);
    expect(a.work.get('af-acme')).toBe('ada@startup.io');
    expect(a.review).toEqual([]);
  });
  it('a household override on the secondary suppresses its review row', () => {
    const overrides = parseEmailKindOverrides('email,kind,affiliationSfId\nfamily@startup.io,household,\n');
    const a = assignEmails({ Email: 'ada@gmail.com', Secondary_Email__c: 'family@startup.io' },
      [atAcme], orgDomains, consumer, overrides);
    expect(a.household).toBe('family@startup.io');
    expect(a.review).toEqual([]);
  });
  it('no addresses at all → everything null, nothing to review', () => {
    const a = assignEmails({}, [atAcme], orgDomains, consumer, none);
    expect(a).toEqual({ personal: null, household: null, work: new Map(), swapped: false, review: [] });
  });
});

describe('parseEmailKindOverrides', () => {
  it('lowercases emails, tolerates a blank affiliation, skips bad kinds and blank lines', () => {
    const m = parseEmailKindOverrides(
      'email,kind,affiliationSfId\nA@B.C,work,af1\n\nx@y.z,household,\nbad@k.ind,nonsense,\n');
    expect(m.get('a@b.c')).toEqual({ email: 'a@b.c', kind: 'work', affiliationSfId: 'af1' });
    expect(m.get('x@y.z')).toEqual({ email: 'x@y.z', kind: 'household', affiliationSfId: null });
    expect(m.has('bad@k.ind')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/transform/emails.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/transform/emails.ts
import { collapseEmail } from './fields.js';
import { classifyDomain, emailDomain } from './emailKind.js';

export interface AffiliationRef { sfId: string; orgSfId: string; primary: boolean }
export interface EmailOverride { email: string; kind: 'personal' | 'household' | 'work'; affiliationSfId: string | null }
export interface EmailAssignment {
  personal: string | null;
  household: string | null;
  work: Map<string, string>;
  swapped: boolean;
  review: { email: string; domain: string }[];
}

const KINDS = new Set(['personal', 'household', 'work']);

// data/enrich/email-kinds.csv — a human's answer for addresses the domain rules couldn't
// place (rows copied from data/review/email-classification.csv). Header: email,kind,affiliationSfId.
export function parseEmailKindOverrides(csv: string): Map<string, EmailOverride> {
  const out = new Map<string, EmailOverride>();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [emailRaw = '', kindRaw = '', afRaw = ''] = line.split(',').map((s) => s.trim());
    const email = emailRaw.toLowerCase();
    const kind = kindRaw.toLowerCase();
    if (!email || !KINDS.has(kind)) continue;
    out.set(email, { email, kind: kind as EmailOverride['kind'], affiliationSfId: afRaw || null });
  }
  return out;
}

type Placed = { kind: 'work'; affiliationSfId: string } | { kind: 'personal' } | { kind: 'household' } | { kind: 'unknown' };

function pickAffiliationForOrg(affiliations: readonly AffiliationRef[], orgSfId: string): AffiliationRef | null {
  const atOrg = affiliations.filter((a) => a.orgSfId === orgSfId);
  return atOrg.find((a) => a.primary) ?? atOrg[0] ?? null;
}

export function assignEmails(
  contact: Record<string, unknown>,
  affiliations: readonly AffiliationRef[],
  orgDomainByOrgId: ReadonlyMap<string, string>,
  consumerDomains: ReadonlySet<string>,
  overrides: ReadonlyMap<string, EmailOverride>,
): EmailAssignment {
  const primary = collapseEmail(contact);
  const secondary = (contact['Secondary_Email__c'] as string | null)?.trim().toLowerCase() || null;
  const candidateOrgIds = affiliations.map((a) => a.orgSfId);

  const place = (email: string): Placed => {
    const o = overrides.get(email);
    if (o?.kind === 'work' && o.affiliationSfId) return { kind: 'work', affiliationSfId: o.affiliationSfId };
    if (o?.kind === 'personal') return { kind: 'personal' };
    if (o?.kind === 'household') return { kind: 'household' };
    const d = classifyDomain(emailDomain(email), candidateOrgIds, orgDomainByOrgId, consumerDomains);
    if (d.kind === 'work') {
      const af = pickAffiliationForOrg(affiliations, d.orgSfId);
      if (af) return { kind: 'work', affiliationSfId: af.sfId };
    }
    return d.kind === 'consumer' ? { kind: 'personal' } : { kind: 'unknown' };
  };

  const out: EmailAssignment = { personal: primary, household: null, work: new Map(), swapped: false, review: [] };
  if (!primary && !secondary) return out;

  const primaryPlaced = primary ? place(primary) : null;
  const secondaryPlaced = secondary ? place(secondary) : null;

  if (secondary && secondaryPlaced) {
    if (secondaryPlaced.kind === 'work') out.work.set(secondaryPlaced.affiliationSfId, secondary);
    else {
      out.household = secondary;
      if (secondaryPlaced.kind === 'unknown') out.review.push({ email: secondary, domain: emailDomain(secondary) ?? '' });
    }
  }

  // The one swap: primary is demonstrably a work address and the secondary is demonstrably a
  // personal mailbox. Any other shape keeps the primary as Personal.
  if (primary && primaryPlaced?.kind === 'work' && secondary && secondaryPlaced?.kind === 'personal') {
    out.personal = secondary;
    out.household = null;
    out.work.set(primaryPlaced.affiliationSfId, primary);
    out.swapped = true;
  }
  return out;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/transform/emails.test.ts && npm run typecheck`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transform/emails.ts src/transform/emails.test.ts
git commit -m "feat(salesforce-import): assign each contact's addresses to personal, household, or work"
```

---

## Task 5: `affiliations.ts` — Affiliation payloads

**Files:**
- Create: `src/transform/affiliations.ts`
- Modify: `src/transform/fields.ts:73-91` (extract `consentLabel`)
- Test: `src/transform/affiliations.test.ts`, `src/transform/fields.test.ts`

**Interfaces:**
- Consumes: `dateCol`, `salesforceDebug` from `fields.ts`; `consentLabel` (new, below).
- Produces:
  ```ts
  // fields.ts
  export function consentLabel(email: string | null, consent: ReadonlyMap<string, string>): string;
  // affiliations.ts
  export interface AffiliationContext { personName: string; orgName: string; workEmail: string | null; consent: ReadonlyMap<string, string> }
  export function affiliationStatus(raw: unknown): 'Current' | 'Former';
  export function affiliationToPayload(a: Record<string, unknown>, ctx: AffiliationContext): ItemPayload;   // board 'affiliations'
  export interface Tenure { sfId: string; startISO: string | null; endISO: string | null; primary: boolean }
  export function pickAffiliation<T extends Tenure>(candidates: readonly T[], onISO: string | null): T | null;
  ```
  Payload column titles: `Role`, `Status`, `Start`, `End`, `Primary`, `Work Email`,
  `Work Email Consent` (only when `workEmail` is set), `Salesforce Debug`. Links: `Person` →
  `[npe5__Contact__c]`, `Organization` → `[npe5__Organization__c]`. Name: `<personName> @ <orgName>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/transform/fields.test.ts`:

```ts
import { consentLabel } from './fields.js';   // add to the existing import line instead

describe('consentLabel', () => {
  const consent = new Map([['a@b.c', 'cleaned']]);
  it('capitalizes the Mailchimp status and defaults to Not in Mailchimp', () => {
    expect(consentLabel('a@b.c', consent)).toBe('Cleaned');
    expect(consentLabel('x@y.z', consent)).toBe('Not in Mailchimp');
    expect(consentLabel(null, consent)).toBe('Not in Mailchimp');
  });
});
```

Create `src/transform/affiliations.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { affiliationToPayload, affiliationStatus, pickAffiliation } from './affiliations.js';

const prov = { CreatedDate: '2020-01-01T00:00:00Z', CreatedBy: { Name: 'X' },
  LastModifiedDate: '2021-01-01T00:00:00Z', LastModifiedBy: { Name: 'Y' } };

describe('affiliationStatus', () => {
  it('is Former only when Salesforce says so; blank means Current (NPSP default)', () => {
    expect(affiliationStatus('Former')).toBe('Former');
    expect(affiliationStatus('Current')).toBe('Current');
    expect(affiliationStatus(null)).toBe('Current');
    expect(affiliationStatus(undefined)).toBe('Current');
  });
});

describe('affiliationToPayload', () => {
  const a = { Id: 'af1', npe5__Contact__c: 'c1', npe5__Organization__c: 'org-acme', npe5__Role__c: 'Sustainability Lead',
    npe5__Status__c: 'Current', npe5__StartDate__c: '2019-03-01', npe5__EndDate__c: null, npe5__Primary__c: true, ...prov };
  it('builds the full column set with both links and the work address consent', () => {
    const p = affiliationToPayload(a, { personName: 'Ada Lovelace', orgName: 'Acme',
      workEmail: 'ada@acme.example', consent: new Map([['ada@acme.example', 'subscribed']]) });
    expect(p.board).toBe('affiliations');
    expect(p.sfId).toBe('af1');
    expect(p.name).toBe('Ada Lovelace @ Acme');
    expect(p.columns['Role']).toBe('Sustainability Lead');
    expect(p.columns['Status']).toEqual({ label: 'Current' });
    expect(p.columns['Start']).toEqual({ date: '2019-03-01' });
    expect(p.columns['End']).toBeNull();
    expect(p.columns['Primary']).toEqual({ checked: 'true' });
    expect(p.columns['Work Email']).toEqual({ email: 'ada@acme.example', text: 'ada@acme.example' });
    expect(p.columns['Work Email Consent']).toEqual({ label: 'Subscribed' });
    expect(p.columns['Salesforce Debug']).toEqual({ text: expect.stringContaining('SF ID: af1') });
    expect(p.links).toEqual([
      { column: 'Person', targetSfIds: ['c1'] },
      { column: 'Organization', targetSfIds: ['org-acme'] },
    ]);
  });
  it('omits Work Email and its consent when the tenure has no work address', () => {
    const p = affiliationToPayload({ ...a, npe5__Primary__c: false }, { personName: 'Ada', orgName: 'Acme', workEmail: null, consent: new Map() });
    expect(p.columns['Work Email']).toBeNull();
    expect('Work Email Consent' in p.columns).toBe(false);
    expect(p.columns['Primary']).toBeNull();
  });
});

describe('pickAffiliation', () => {
  const old = { sfId: 'old', startISO: '2015-01-01', endISO: '2018-12-31', primary: false };
  const now = { sfId: 'now', startISO: '2019-01-01', endISO: null, primary: true };
  const undated = { sfId: 'undated', startISO: null, endISO: null, primary: false };
  it('prefers the tenure whose dates bracket the event', () => {
    expect(pickAffiliation([now, old], '2016-06-01')?.sfId).toBe('old');
    expect(pickAffiliation([old, now], '2022-06-01')?.sfId).toBe('now');
  });
  it('falls back to Primary, then first, when no tenure brackets the date or the date is unknown', () => {
    expect(pickAffiliation([old, now], '2000-01-01')?.sfId).toBe('now');
    expect(pickAffiliation([old, undated], null)?.sfId).toBe('old');
    expect(pickAffiliation([undated], '2022-06-01')?.sfId).toBe('undated');   // open-ended tenure brackets everything
  });
  it('is null for no candidates', () => {
    expect(pickAffiliation([], '2022-01-01')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/transform/affiliations.test.ts src/transform/fields.test.ts`
Expected: FAIL — `consentLabel` not exported; `affiliations.js` not found.

- [ ] **Step 3: Extract `consentLabel` in `fields.ts`**

Replace the body of `consentColumns` so both callers share one labeler (the column titles are
renamed in Task 6; leave them as they are for now):

```ts
export function consentLabel(email: string | null, consent: ReadonlyMap<string, string>): string {
  const status = email ? consent.get(email) : undefined;
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Not in Mailchimp';
}

export function consentColumns(
  email: string | null, secondary: string | null, consent: Map<string, string>,
): Record<string, unknown> {
  const columns: Record<string, unknown> = { 'Email Consent': { label: consentLabel(email, consent) } };
  if (secondary) columns['Secondary Email Consent'] = { label: consentLabel(secondary, consent) };
  return columns;
}
```

(Keep the explanatory comment block above `consentColumns` as it is.)

- [ ] **Step 4: Implement `affiliations.ts`**

```ts
// src/transform/affiliations.ts
import type { ItemPayload } from './types.js';
import { consentLabel, dateCol, salesforceDebug } from './fields.js';

export interface AffiliationContext {
  personName: string; orgName: string; workEmail: string | null; consent: ReadonlyMap<string, string>;
}
export interface Tenure { sfId: string; startISO: string | null; endISO: string | null; primary: boolean }

// NPSP's picklist is Current / Former with Current as the default, so a blank is Current.
export function affiliationStatus(raw: unknown): 'Current' | 'Former' {
  return raw === 'Former' ? 'Former' : 'Current';
}

const emailCol = (e: string | null) => (e ? { email: e, text: e } : null);

export function affiliationToPayload(a: Record<string, unknown>, ctx: AffiliationContext): ItemPayload {
  const columns: Record<string, unknown> = {
    'Role': (a['npe5__Role__c'] ?? '') as string,
    'Status': { label: affiliationStatus(a['npe5__Status__c']) },
    'Start': dateCol(a['npe5__StartDate__c'] as string | null),
    'End': dateCol(a['npe5__EndDate__c'] as string | null),
    'Primary': a['npe5__Primary__c'] === true ? { checked: 'true' } : null,
    'Work Email': emailCol(ctx.workEmail),
    ...salesforceDebug(a),
  };
  if (ctx.workEmail) columns['Work Email Consent'] = { label: consentLabel(ctx.workEmail, ctx.consent) };
  return {
    board: 'affiliations', sfId: a['Id'] as string,
    name: `${ctx.personName} @ ${ctx.orgName}`,
    columns,
    links: [
      { column: 'Person', targetSfIds: [a['npe5__Contact__c'] as string] },
      { column: 'Organization', targetSfIds: [a['npe5__Organization__c'] as string] },
    ],
  };
}

// Which of a person's tenures at ONE organization an event on `onISO` belongs to: the one
// whose dates bracket it (an open end brackets everything after its start; no dates at all
// brackets everything), else the Primary-flagged one, else the first.
export function pickAffiliation<T extends Tenure>(candidates: readonly T[], onISO: string | null): T | null {
  if (candidates.length === 0) return null;
  const day = onISO?.slice(0, 10) ?? null;
  if (day) {
    const bracketing = candidates.find((t) =>
      (t.startISO === null || t.startISO.slice(0, 10) <= day) &&
      (t.endISO === null || day <= t.endISO.slice(0, 10)));
    if (bracketing) return bracketing;
  }
  return candidates.find((t) => t.primary) ?? candidates[0] ?? null;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/transform/ && npm run typecheck`
Expected: PASS, including the untouched `consentColumns` tests.

- [ ] **Step 6: Commit**

```bash
git add src/transform/affiliations.ts src/transform/affiliations.test.ts src/transform/fields.ts src/transform/fields.test.ts
git commit -m "feat(salesforce-import): build Affiliations-board payloads with per-tenure work email"
```

---

## Task 6: People — Personal / Household emails, Household Primary, Affiliations link

**Files:**
- Modify: `src/transform/fields.ts` (`consentColumns` signature and titles),
  `src/transform/people.ts:29-56` (`contactToPayload`)
- Test: `src/transform/fields.test.ts`, `src/transform/people.test.ts`

**Interfaces:**
- Consumes: `EmailAssignment` (Task 4).
- Produces: `contactToPayload(c, board, deps)` where `deps` gains
  ```ts
  emails?: { personal: string | null; household: string | null };   // default: collapseEmail / Secondary_Email__c
  householdPrimary?: boolean;                                        // default false
  affiliationSfIds?: string[];                                       // default []
  ```
  and the People payload's column titles become `Personal Email`, `Personal Email Consent`,
  `Household Email`, `Household Email Consent`, `Household Primary` (only when true), plus a
  link `Affiliations` → `affiliationSfIds` when non-empty. `consentColumns(personal, household, consent)`
  emits the new titles.

- [ ] **Step 1: Update the failing tests**

In `src/transform/fields.test.ts`, replace the `consentColumns` describe block:

```ts
describe('consentColumns', () => {
  const consent = new Map([['a@b.c', 'unsubscribed'], ['w@b.c', 'subscribed']]);
  it('labels each address on its own — consent is per email, not per person', () => {
    expect(consentColumns('a@b.c', 'w@b.c', consent)).toEqual({
      'Personal Email Consent': { label: 'Unsubscribed' }, 'Household Email Consent': { label: 'Subscribed' } });
    expect(consentColumns('missing@x.y', 'a@b.c', consent)).toEqual({
      'Personal Email Consent': { label: 'Not in Mailchimp' }, 'Household Email Consent': { label: 'Unsubscribed' } });
  });
  it('keeps the personal column never blank, but leaves household blank when there is no household address', () => {
    expect(consentColumns(null, null, consent)).toEqual({ 'Personal Email Consent': { label: 'Not in Mailchimp' } });
    expect(consentColumns('a@b.c', null, consent)).toEqual({ 'Personal Email Consent': { label: 'Unsubscribed' } });
  });
});
```

In `src/transform/people.test.ts`, in the first `contactToPayload` test change the assertions:

```ts
    expect(p.columns['Personal Email']).toEqual({ email: 'ada@x.co', text: 'ada@x.co' });
    expect(p.columns['Household Email']).toEqual({ email: 'work@x.co', text: 'work@x.co' });
    // ...
    expect(p.columns['Personal Email Consent']).toEqual({ label: 'Subscribed' });
    expect(p.columns['Household Email Consent']).toEqual({ label: 'Unsubscribed' });
    expect('Household Primary' in p.columns).toBe(false);
```

and add a new test in the same describe:

```ts
  it('takes an explicit email assignment, Household Primary, and the Affiliations link', () => {
    const p = contactToPayload(
      { Id: 'c9', FirstName: 'Ada', LastName: 'L', Email: 'ada@acme.example', Secondary_Email__c: 'ada@gmail.com' },
      'people-live',
      { consent: new Map([['ada@gmail.com', 'subscribed']]),
        emails: { personal: 'ada@gmail.com', household: null },
        householdPrimary: true, affiliationSfIds: ['af1', 'af2'] });
    expect(p.columns['Personal Email']).toEqual({ email: 'ada@gmail.com', text: 'ada@gmail.com' });
    expect(p.columns['Household Email']).toBeNull();
    expect(p.columns['Personal Email Consent']).toEqual({ label: 'Subscribed' });
    expect('Household Email Consent' in p.columns).toBe(false);
    expect(p.columns['Household Primary']).toEqual({ checked: 'true' });
    expect(p.links).toContainEqual({ column: 'Affiliations', targetSfIds: ['af1', 'af2'] });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/transform/fields.test.ts src/transform/people.test.ts`
Expected: FAIL on the renamed titles.

- [ ] **Step 3: Rename in `fields.ts`**

```ts
// Mailchimp subscription state belongs to an email address, not a person, so each email column
// on People gets its own consent status. Personal Email Consent is never blank ("Not in
// Mailchimp" also covers "no email at all") so the "who's missing from Mailchimp" filter stays
// reliable; Household Email Consent is left blank when there is no household address.
export function consentColumns(
  personal: string | null, household: string | null, consent: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const columns: Record<string, unknown> = { 'Personal Email Consent': { label: consentLabel(personal, consent) } };
  if (household) columns['Household Email Consent'] = { label: consentLabel(household, consent) };
  return columns;
}
```

- [ ] **Step 4: Update `contactToPayload` in `people.ts`**

```ts
export function contactToPayload(
  c: Record<string, unknown>, board: 'people-live' | 'people-historical',
  deps: {
    consent: Map<string, string>; member?: MemberSummary; geo?: GeoResult;
    // From transform/emails.ts. Absent → the pre-affiliation behavior: primary address is
    // Personal, Secondary_Email__c is Household, no work address is separated out.
    emails?: { personal: string | null; household: string | null };
    householdPrimary?: boolean;
    affiliationSfIds?: string[];
  },
): ItemPayload {
  const personal = deps.emails ? deps.emails.personal : collapseEmail(c);
  const household = deps.emails ? deps.emails.household
    : ((c['Secondary_Email__c'] as string | null)?.trim().toLowerCase() || null);
  const account = c['Account'] as { Do_Not_Solicit__c?: boolean; Do_Not_Solicit_What__c?: string;
    Owner?: { Name?: string } } | null;
  const columns: Record<string, unknown> = {
    'Personal Email': emailCol(personal),
    'Household Email': emailCol(household),
    'Phone': (c['Phone'] ?? c['MobilePhone'] ?? '') as string,
    'Address': [c['MailingStreet'], c['MailingCity'], c['MailingState'], c['MailingPostalCode']]
      .filter(Boolean).join(', '),
    'Funraise Profile': funraiseSupporterLink(c['funraise__fr_ID__c']),
    'City': deps.geo?.city ?? '', 'Zip': deps.geo?.zip ?? '',
    'Lat': deps.geo ? String(deps.geo.lat) : '', 'Lng': deps.geo ? String(deps.geo.lng) : '',
    'Do Not Solicit': account?.Do_Not_Solicit__c ? { checked: 'true' } : null,
    'Do Not Solicit Reason': (account?.Do_Not_Solicit_What__c ?? '') as string,
    // The one-to-one Account's owner, not a Contact-level owner field — matches how
    // monday-migration docs/05 §9 verified this (Account.OwnerId, not Contact.OwnerId).
    'Salesforce Owner': ownerAttribution(account?.Owner),
    'Employer Name': (c['dtd__company__c'] ?? '') as string,
    ...consentColumns(personal, household, deps.consent),
    ...salesforceDebug(c),
  };
  // A shared household address is one Mailchimp contact; this flag says whose merge fields it
  // carries (spec: "Consent and mailchimp-sync"). Only ever written as true.
  if (deps.householdPrimary) columns['Household Primary'] = { checked: 'true' };
  if (deps.member) {
    columns['Membership Status'] = { label: deps.member.status };
    columns['Membership Tier'] = { label: deps.member.tier };
    columns['Member Since'] = dateCol(deps.member.sinceISO);
    columns['Member Until'] = dateCol(deps.member.untilISO);
  }
  const links: ItemPayload['links'] = [];
  if (c['AccountId']) links.push({ column: 'Organization', targetSfIds: [c['AccountId'] as string] });
  if (deps.affiliationSfIds && deps.affiliationSfIds.length > 0) {
    links.push({ column: 'Affiliations', targetSfIds: deps.affiliationSfIds });
  }
  return {
    board, sfId: c['Id'] as string,
    name: [c['FirstName'], c['LastName']].filter(Boolean).join(' ') || '(no name)',
    columns,
    links,
  };
}
```

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run && npm run typecheck`
Expected: PASS. The integration test (`index.test.ts`) does not yet assert on email titles, and
`load/boards.ts` still declares the old titles until Task 7, so nothing else breaks here. `load`
against a real board would fail between this task and Task 7 (payloads use titles load doesn't
know) — don't run it in between.

- [ ] **Step 6: Commit**

```bash
git add src/transform/fields.ts src/transform/fields.test.ts src/transform/people.ts src/transform/people.test.ts
git commit -m "feat(salesforce-import): People carry Personal and Household emails, Household Primary, Affiliations link"
```

---

## Task 7: Load — new board, new columns, in-place renames

**Files:**
- Modify: `src/load/boards.ts` (COLUMN_TYPES, STATUS_LABELS, `statusLabelsFor`, CONNECT_COLUMNS,
  CONNECT_TARGETS, CURRENCY_COLUMNS, BOARD_LABELS, `ensureBoards` pass 2),
  `src/load/index.ts:717-718` (ORDER)
- Test: `src/load/boards.test.ts`

**Interfaces:**
- Produces: `COLUMN_RENAMES: Record<string, Record<string, string>>` keyed by board key; the
  `affiliations` board key; and these declared titles:

  | Title | Type / labels |
  |---|---|
  | `Personal Email`, `Household Email`, `Work Email` | `email` |
  | `Personal Email Consent`, `Household Email Consent`, `Work Email Consent` | `status`, consent vocabulary |
  | `Household Primary`, `Primary` | `checkbox` |
  | `Role` | `text` |
  | `Status` on `affiliations` only | `status`, `Current / Former` |
  | `Attribution` | `status`, `Auto / Staff / Needs review / None` |
  | `Organizational Giving`, `Attributed Giving` | `numbers`, currency |
  | `Attributed Gift Count` | `numbers` |
  | `Last Attributed Gift` | `date` |
  | `Acting for` | connect → `affiliations` |
  | `Affiliations` | connect → `affiliations` |

  `Start` / `End` (`date`) and `Person` / `Organization` (connect) already exist.

- [ ] **Step 1: Write the failing tests**

In `src/load/boards.test.ts`, extend the "every transform column title has a declared type"
list:

```ts
    for (const title of ['Salesforce Debug', 'Personal Email', 'Household Email', 'Work Email',
      'Personal Email Consent', 'Household Email Consent', 'Work Email Consent', 'Household Primary',
      'Role', 'Primary', 'Attribution', 'Organizational Giving', 'Attributed Giving',
      'Attributed Gift Count', 'Last Attributed Gift', 'Term Start', 'Lifetime Giving',
      'Annualized Value', 'Historical']) {
      expect(COLUMN_TYPES[title], title).toBeDefined();
    }
    for (const title of ['Acting for', 'Affiliations']) {
      expect(CONNECT_COLUMNS.has(title), title).toBe(true);
      expect(CONNECT_TARGETS[title], title).toEqual(['affiliations']);
    }
```

(import `CONNECT_COLUMNS` alongside `CONNECT_TARGETS`.) In the "closed-vocabulary status columns"
test, change the requested set and assertions:

```ts
    await ensureBoards(client, loadConfig(), ['people-live', 'affiliations'], new Map([
      ['people-live', new Set(['Personal Email Consent', 'Household Email Consent', 'Membership Status', 'Membership Tier'])],
      ['affiliations', new Set(['Status', 'Work Email Consent', 'Attribution'])],
    ]));
    const consent = { 0: 'Subscribed', 1: 'Unsubscribed', 2: 'Cleaned', 3: 'Not in Mailchimp' };
    expect(JSON.parse(defaultsByTitle['Personal Email Consent']!).labels).toEqual(consent);
    expect(JSON.parse(defaultsByTitle['Household Email Consent']!).labels).toEqual(consent);
    expect(JSON.parse(defaultsByTitle['Work Email Consent']!).labels).toEqual(consent);
    expect(JSON.parse(defaultsByTitle['Status']!).labels).toEqual({ 0: 'Current', 1: 'Former' });
    expect(JSON.parse(defaultsByTitle['Attribution']!).labels).toEqual(
      { 0: 'Auto', 1: 'Staff', 2: 'Needs review', 3: 'None' });
    expect(JSON.parse(defaultsByTitle['Membership Status']!).labels).toEqual({ 0: 'Active', 1: 'Lapsed' });
```

(The scripted `create_board` in that test returns one id for both boards; that is fine for a
defaults check.) Add a new test:

```ts
  it('renames the four People email columns in place instead of creating duplicates', async () => {
    const renamed: { id: string; title: string }[] = [];
    const created: string[] = [];
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [
        { id: 'email_1', title: 'Email', type: 'email' }, { id: 'email_2', title: 'Secondary Email', type: 'email' },
        { id: 'status_1', title: 'Email Consent', type: 'status' }, { id: 'status_2', title: 'Secondary Email Consent', type: 'status' },
      ] }] } });
      if (/change_column_title/.test(query)) {
        renamed.push({ id: variables.columnId as string, title: variables.title as string });
        return Response.json({ data: { change_column_title: { id: variables.columnId } } });
      }
      if (/create_column/.test(query)) { created.push(variables.title as string); return Response.json({ data: { create_column: { id: `col_${variables.title}` } } }); }
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
    const cfg = loadConfig();
    cfg.monday.boards['people-live'] = 4242;   // existing board, so no create_board
    const map = await ensureBoards(client, cfg, ['people-live'], new Map([
      ['people-live', new Set(['Personal Email', 'Household Email', 'Personal Email Consent', 'Household Email Consent', 'Household Primary'])],
    ]));
    expect(renamed).toEqual([
      { id: 'email_1', title: 'Personal Email' }, { id: 'email_2', title: 'Household Email' },
      { id: 'status_1', title: 'Personal Email Consent' }, { id: 'status_2', title: 'Household Email Consent' },
    ]);
    expect(created).toEqual(['Household Primary']);
    expect(map['people-live']!.columns['Personal Email']).toBe('email_1');
    expect('Email' in map['people-live']!.columns).toBe(false);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/load/boards.test.ts`
Expected: FAIL — undeclared titles, no rename mutation.

- [ ] **Step 3: Declare the schema in `boards.ts`**

Edit `COLUMN_TYPES`: replace the `'Email': 'email', 'Secondary Email': 'email',` pair with

```ts
  'Personal Email': 'email', 'Household Email': 'email', 'Work Email': 'email',
```

replace the `'Email Consent': 'status', 'Secondary Email Consent': 'status',` line with

```ts
  'Personal Email Consent': 'status', 'Household Email Consent': 'status', 'Work Email Consent': 'status',
  'Household Primary': 'checkbox', 'Primary': 'checkbox', 'Role': 'text', 'Attribution': 'status',
  'Organizational Giving': 'numbers', 'Attributed Giving': 'numbers',
  'Attributed Gift Count': 'numbers', 'Last Attributed Gift': 'date',
```

Edit `CONNECT_COLUMNS` to add `'Acting for', 'Affiliations'`. In `STATUS_LABELS`, replace the two
consent entries with:

```ts
  'Personal Email Consent': ['Subscribed', 'Unsubscribed', 'Cleaned', 'Not in Mailchimp'],
  'Household Email Consent': ['Subscribed', 'Unsubscribed', 'Cleaned', 'Not in Mailchimp'],
  'Work Email Consent': ['Subscribed', 'Unsubscribed', 'Cleaned', 'Not in Mailchimp'],
  'Attribution': ['Auto', 'Staff', 'Needs review', 'None'],
```

Below `DONATION_STATUS_LABELS` add `const AFFILIATION_STATUS_LABELS = ['Current', 'Former'];` and
extend `statusLabelsFor`:

```ts
function statusLabelsFor(key: string, title: string): string[] | undefined {
  if (title === 'Status' && key === 'donations') return DONATION_STATUS_LABELS;
  if (title === 'Status' && key === 'affiliations') return AFFILIATION_STATUS_LABELS;
  return STATUS_LABELS[title];
}
```

Add `'Organizational Giving', 'Attributed Giving'` to `CURRENCY_COLUMNS`. In `CONNECT_TARGETS`
add `'Acting for': ['affiliations'], 'Affiliations': ['affiliations'],`. In `BOARD_LABELS` add
`'affiliations': 'Affiliations',`.

- [ ] **Step 4: Add the in-place rename to pass 2**

Above `ensureBoards`, declare:

```ts
// Titles that changed meaning after the sandbox boards were first provisioned. Renaming keeps the
// column id (and every value already on it) instead of leaving an orphan next to a fresh empty
// column. Keyed by board so an unrelated board with an "Email" column is never touched.
export const COLUMN_RENAMES: Record<string, Record<string, string>> = {
  'people-live': { 'Email': 'Personal Email', 'Secondary Email': 'Household Email',
    'Email Consent': 'Personal Email Consent', 'Secondary Email Consent': 'Household Email Consent' },
  'people-historical': { 'Email': 'Personal Email', 'Secondary Email': 'Household Email',
    'Email Consent': 'Personal Email Consent', 'Secondary Email Consent': 'Household Email Consent' },
};
```

In pass 2, right after the loop that fills `entry.columns` from the fetched columns, insert:

```ts
    for (const [oldTitle, newTitle] of Object.entries(COLUMN_RENAMES[key] ?? {})) {
      const id = entry.columns[oldTitle];
      if (!id || entry.columns[newTitle]) continue;   // nothing to rename, or already done
      await client.gql(
        `mutation ($board: ID!, $columnId: String!, $title: String!) {
           change_column_title (board_id: $board, column_id: $columnId, title: $title) { id } }`,
        { board: String(entry.boardId), columnId: id, title: newTitle });
      entry.columns[newTitle] = id;
      delete entry.columns[oldTitle];
    }
```

- [ ] **Step 5: Add `affiliations` to the load order**

In `src/load/index.ts`, change `ORDER` to:

```ts
const ORDER = ['organizations', 'people-live', 'people-historical', 'affiliations', 'campaigns',
  'recurring-gifts', 'events', 'event-registrations', 'donations', 'volunteers', 'activities'];
```

Affiliations link to People and Organizations (must exist first) and are linked *from* Event
Registrations and Donations (which load later), so this position is the only valid one. Update
the comment above `ORDER` with that sentence.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run src/load && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/load/boards.ts src/load/boards.test.ts src/load/index.ts
git commit -m "feat(salesforce-import): provision the Affiliations board and rename People email columns in place"
```

---

## Task 8: `attribution.ts` — historical "Acting for" and seed rollups

**Files:**
- Create: `src/transform/attribution.ts`
- Modify: `src/transform/donations.ts:14-40` (`opportunityToPayload`), `src/transform/boards.ts:51-68`
  (`registrationToPayload`)
- Test: `src/transform/attribution.test.ts`, `src/transform/donations.test.ts`, `src/transform/boards.test.ts`

**Interfaces:**
- Consumes: `pickAffiliation`, `Tenure` (Task 5); `RECEIVED` semantics from `rollups.ts` (Posted only).
- Produces:
  ```ts
  export interface AffiliationEntry extends Tenure { contactSfId: string; orgSfId: string; workEmail: string | null }
  export class AffiliationIndex {
    constructor(entries: readonly AffiliationEntry[]);
    byContactOrg(contactSfId: string, orgSfId: string): AffiliationEntry[];
    byWorkEmail(email: string): AffiliationEntry | null;
    byContact(contactSfId: string): AffiliationEntry[];
    bySfId(sfId: string): AffiliationEntry | null;
  }
  export type OpportunityAttribution =
    | { affiliationSfId: string }
    | { unaffiliated: { contactSfId: string; orgSfId: string } }
    | null;
  export function attributeOpportunity(o: Record<string, unknown>, index: AffiliationIndex, orgAccountIds: ReadonlySet<string>): OpportunityAttribution;
  export function attributeRegistration(r: Record<string, unknown>, index: AffiliationIndex): string | null;
  export function attributionColumns(affiliationSfId: string | null): { columns: Record<string, unknown>; links: { column: string; targetSfIds: string[] }[] };
  export interface AttributionRollup { giving: number; giftCount: number; lastGiftISO: string | null }
  export function attributionRollups(
    opportunities: readonly Record<string, unknown>[], attributed: ReadonlyMap<string, string>, index: AffiliationIndex,
  ): { byAffiliation: Map<string, AttributionRollup>; organizationalGivingByContact: Map<string, number> };
  ```
  `opportunityToPayload(o, deps)` and `registrationToPayload(r, deps?)` accept
  `deps.actingFor?: string | null` and spread `attributionColumns(actingFor ?? null)`.

**Rule:** an Opportunity whose `AccountId` is an organization Account and whose
`npsp__Primary_Contact__c` is set is a gift the contact drove for that organization (NPSP's
org-gift pattern; an individual's own gift has a One-to-One household `AccountId` instead).
If the pair has an affiliation, `Acting for` = the tenure bracketing `CloseDate`. If it has none,
the gift is reported for review, not invented.

- [ ] **Step 1: Write the failing tests**

```ts
// src/transform/attribution.test.ts
import { describe, it, expect } from 'vitest';
import { AffiliationIndex, attributeOpportunity, attributeRegistration, attributionColumns,
  attributionRollups, type AffiliationEntry } from './attribution.js';

const entries: AffiliationEntry[] = [
  { sfId: 'af-old', contactSfId: 'c1', orgSfId: 'org-acme', startISO: '2015-01-01', endISO: '2018-12-31', primary: false, workEmail: null },
  { sfId: 'af-new', contactSfId: 'c1', orgSfId: 'org-acme', startISO: '2019-01-01', endISO: null, primary: true, workEmail: 'ada@acme.example' },
  { sfId: 'af-city', contactSfId: 'c2', orgSfId: 'org-city', startISO: null, endISO: null, primary: true, workEmail: 'bo@sanjoseca.gov' },
];
const index = new AffiliationIndex(entries);
const orgs = new Set(['org-acme', 'org-city']);

describe('attributeOpportunity', () => {
  it('attributes an org gift with a primary contact to the tenure bracketing its close date', () => {
    expect(attributeOpportunity({ AccountId: 'org-acme', npsp__Primary_Contact__c: 'c1', CloseDate: '2017-05-05' }, index, orgs))
      .toEqual({ affiliationSfId: 'af-old' });
    expect(attributeOpportunity({ AccountId: 'org-acme', npsp__Primary_Contact__c: 'c1', CloseDate: '2024-05-05' }, index, orgs))
      .toEqual({ affiliationSfId: 'af-new' });
  });
  it('reports an org gift whose contact has no affiliation there', () => {
    expect(attributeOpportunity({ AccountId: 'org-city', npsp__Primary_Contact__c: 'c1', CloseDate: '2024-01-01' }, index, orgs))
      .toEqual({ unaffiliated: { contactSfId: 'c1', orgSfId: 'org-city' } });
  });
  it('is null for individual gifts, org gifts with no contact, and Funraise-only donors', () => {
    expect(attributeOpportunity({ AccountId: 'a-household', npsp__Primary_Contact__c: 'c1' }, index, orgs)).toBeNull();
    expect(attributeOpportunity({ AccountId: 'org-acme' }, index, orgs)).toBeNull();
    expect(attributeOpportunity({ AccountId: 'org-acme', funraise__fr_Donor__c: 'c1' }, index, orgs)).toBeNull();
  });
});

describe('attributeRegistration', () => {
  it('matches the registration email against work addresses, case-insensitively', () => {
    expect(attributeRegistration({ funraise__Email__c: 'Bo@SanJoseCA.gov' }, index)).toBe('af-city');
  });
  it('is null for a personal or unknown address', () => {
    expect(attributeRegistration({ funraise__Email__c: 'bo@gmail.com' }, index)).toBeNull();
    expect(attributeRegistration({}, index)).toBeNull();
  });
});

describe('attributionColumns', () => {
  it('writes Auto plus the Acting for link when attributed, None otherwise', () => {
    expect(attributionColumns('af-new')).toEqual({
      columns: { 'Attribution': { label: 'Auto' } },
      links: [{ column: 'Acting for', targetSfIds: ['af-new'] }] });
    expect(attributionColumns(null)).toEqual({ columns: { 'Attribution': { label: 'None' } }, links: [] });
  });
});

describe('attributionRollups', () => {
  const opps = [
    { Id: 'o1', StageName: 'Posted', Amount: 100, CloseDate: '2017-01-01' },
    { Id: 'o2', StageName: 'Posted', Amount: 250.5, CloseDate: '2024-03-03' },
    { Id: 'o3', StageName: 'Closed Won', Amount: 999, CloseDate: '2024-04-04' },   // not Posted → ignored
    { Id: 'o4', StageName: 'Posted', Amount: 40, CloseDate: '2023-01-01' },
  ];
  const attributed = new Map([['o1', 'af-old'], ['o2', 'af-new'], ['o3', 'af-new'], ['o4', 'af-city']]);
  it('sums Posted gifts per affiliation and per contact across their affiliations', () => {
    const r = attributionRollups(opps, attributed, index);
    expect(r.byAffiliation.get('af-old')).toEqual({ giving: 100, giftCount: 1, lastGiftISO: '2017-01-01' });
    expect(r.byAffiliation.get('af-new')).toEqual({ giving: 250.5, giftCount: 1, lastGiftISO: '2024-03-03' });
    expect(r.byAffiliation.get('af-city')).toEqual({ giving: 40, giftCount: 1, lastGiftISO: '2023-01-01' });
    expect(r.organizationalGivingByContact.get('c1')).toBe(350.5);
    expect(r.organizationalGivingByContact.get('c2')).toBe(40);
  });
});
```

Append to `src/transform/donations.test.ts` (inside its `opportunityToPayload` describe, or a new
one if the file has none):

```ts
  it('carries Acting for and Attribution when an affiliation is supplied', () => {
    const base = { Id: 'o9', Name: 'Sponsorship', Amount: 5000, CloseDate: '2024-01-01', StageName: 'Posted',
      AccountId: 'org-acme', npsp__Primary_Contact__c: 'c1' };
    const with_ = opportunityToPayload(base, { termCols: new Map(), actingFor: 'af-new' });
    expect(with_.columns['Attribution']).toEqual({ label: 'Auto' });
    expect(with_.links).toContainEqual({ column: 'Acting for', targetSfIds: ['af-new'] });
    expect(with_.links).toContainEqual({ column: 'Donor', targetSfIds: ['c1'] });   // unchanged
    const without = opportunityToPayload(base, { termCols: new Map() });
    expect(without.columns['Attribution']).toEqual({ label: 'None' });
    expect(without.links!.some((l) => l.column === 'Acting for')).toBe(false);
  });
```

Append to `src/transform/boards.test.ts`:

```ts
  it('registrationToPayload carries Acting for and Attribution', () => {
    const r = { Id: 'r1', funraise__Registrant__c: 'c2', funraise__Email__c: 'bo@sanjoseca.gov' };
    expect(registrationToPayload(r, { actingFor: 'af-city' }).links).toContainEqual({ column: 'Acting for', targetSfIds: ['af-city'] });
    expect(registrationToPayload(r, { actingFor: 'af-city' }).columns['Attribution']).toEqual({ label: 'Auto' });
    expect(registrationToPayload(r).columns['Attribution']).toEqual({ label: 'None' });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/transform/attribution.test.ts src/transform/donations.test.ts src/transform/boards.test.ts`
Expected: FAIL — module not found; `Attribution` undefined.

- [ ] **Step 3: Implement `attribution.ts`**

```ts
// src/transform/attribution.ts
import { pickAffiliation, type Tenure } from './affiliations.js';

export interface AffiliationEntry extends Tenure { contactSfId: string; orgSfId: string; workEmail: string | null }

export class AffiliationIndex {
  private readonly contactOrg = new Map<string, AffiliationEntry[]>();
  private readonly email = new Map<string, AffiliationEntry>();
  private readonly contact = new Map<string, AffiliationEntry[]>();
  private readonly id = new Map<string, AffiliationEntry>();
  constructor(entries: readonly AffiliationEntry[]) {
    for (const e of entries) {
      this.id.set(e.sfId, e);
      const key = `${e.contactSfId}|${e.orgSfId}`;
      (this.contactOrg.get(key) ?? this.contactOrg.set(key, []).get(key)!).push(e);
      (this.contact.get(e.contactSfId) ?? this.contact.set(e.contactSfId, []).get(e.contactSfId)!).push(e);
      if (e.workEmail && !this.email.has(e.workEmail)) this.email.set(e.workEmail, e);
    }
  }
  byContactOrg(contactSfId: string, orgSfId: string): AffiliationEntry[] { return this.contactOrg.get(`${contactSfId}|${orgSfId}`) ?? []; }
  byWorkEmail(email: string): AffiliationEntry | null { return this.email.get(email.trim().toLowerCase()) ?? null; }
  byContact(contactSfId: string): AffiliationEntry[] { return this.contact.get(contactSfId) ?? []; }
  bySfId(sfId: string): AffiliationEntry | null { return this.id.get(sfId) ?? null; }
}

export type OpportunityAttribution =
  | { affiliationSfId: string }
  | { unaffiliated: { contactSfId: string; orgSfId: string } }
  | null;

// NPSP's org-gift shape: AccountId is the organization and Primary Contact is the person who
// drove it. An individual's own gift carries their One-to-One household Account instead, so
// the org-Account check is what separates "acting for" from "as themselves".
export function attributeOpportunity(
  o: Record<string, unknown>, index: AffiliationIndex, orgAccountIds: ReadonlySet<string>,
): OpportunityAttribution {
  const orgSfId = o['AccountId'] as string | null;
  const contactSfId = o['npsp__Primary_Contact__c'] as string | null;
  if (!orgSfId || !contactSfId || !orgAccountIds.has(orgSfId)) return null;
  const tenure = pickAffiliation(index.byContactOrg(contactSfId, orgSfId), o['CloseDate'] as string | null);
  return tenure ? { affiliationSfId: tenure.sfId } : { unaffiliated: { contactSfId, orgSfId } };
}

export function attributeRegistration(r: Record<string, unknown>, index: AffiliationIndex): string | null {
  const email = r['funraise__Email__c'] as string | null;
  return email ? (index.byWorkEmail(email)?.sfId ?? null) : null;
}

export function attributionColumns(affiliationSfId: string | null): {
  columns: Record<string, unknown>; links: { column: string; targetSfIds: string[] }[];
} {
  return affiliationSfId
    ? { columns: { 'Attribution': { label: 'Auto' } }, links: [{ column: 'Acting for', targetSfIds: [affiliationSfId] }] }
    : { columns: { 'Attribution': { label: 'None' } }, links: [] };
}

export interface AttributionRollup { giving: number; giftCount: number; lastGiftISO: string | null }

// Posted only — the same rule as transform/rollups.ts, for the same reconciliation reason.
export function attributionRollups(
  opportunities: readonly Record<string, unknown>[], attributed: ReadonlyMap<string, string>, index: AffiliationIndex,
): { byAffiliation: Map<string, AttributionRollup>; organizationalGivingByContact: Map<string, number> } {
  const cents = new Map<string, number>(), count = new Map<string, number>(), last = new Map<string, string>();
  for (const o of opportunities) {
    const af = attributed.get(o['Id'] as string);
    if (!af || o['StageName'] !== 'Posted') continue;
    cents.set(af, (cents.get(af) ?? 0) + Math.round(Number(o['Amount'] ?? 0) * 100));
    count.set(af, (count.get(af) ?? 0) + 1);
    const d = (o['CloseDate'] as string | null)?.slice(0, 10);
    if (d && (!last.has(af) || d > last.get(af)!)) last.set(af, d);
  }
  const byAffiliation = new Map<string, AttributionRollup>();
  for (const [af, c] of cents) byAffiliation.set(af, { giving: c / 100, giftCount: count.get(af) ?? 0, lastGiftISO: last.get(af) ?? null });
  const orgCents = new Map<string, number>();
  for (const [af, c] of cents) {
    const contact = index.bySfId(af)?.contactSfId;
    if (contact) orgCents.set(contact, (orgCents.get(contact) ?? 0) + c);
  }
  const organizationalGivingByContact = new Map<string, number>();
  for (const [contact, c] of orgCents) organizationalGivingByContact.set(contact, c / 100);
  return { byAffiliation, organizationalGivingByContact };
}
```

- [ ] **Step 4: Thread `actingFor` through the two payload builders**

In `src/transform/donations.ts`, change `opportunityToPayload`'s signature and body:

```ts
import { attributionColumns } from './attribution.js';
// ...
export function opportunityToPayload(
  o: Record<string, unknown>,
  deps: { termCols: Map<string, Record<string, unknown>>; actingFor?: string | null },
): ItemPayload {
  const donorId = (o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c'] ?? o['AccountId']) as string | null;
  const attribution = attributionColumns(deps.actingFor ?? null);
  const links: ItemPayload['links'] = [...attribution.links];
  if (donorId) links.push({ column: 'Donor', targetSfIds: [donorId] });
  // ... unchanged Recurring Gift / Campaign links ...
  return {
    // ... unchanged fields ...
    columns: {
      // ... unchanged columns ...
      ...attribution.columns,
      ...salesforceDebug(o),
    },
    links,
  };
}
```

In `src/transform/boards.ts`, `registrationToPayload(r, deps: { actingFor?: string | null } = {})`:
build `const attribution = attributionColumns(deps.actingFor ?? null);`, start `links` from
`[...attribution.links]`, and spread `...attribution.columns` into `columns` before
`...salesforceDebug(r)`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/transform && npm run typecheck`
Expected: PASS except `index.test.ts` (fixed in Task 9).

- [ ] **Step 6: Commit**

```bash
git add src/transform/attribution.ts src/transform/attribution.test.ts src/transform/donations.ts src/transform/donations.test.ts src/transform/boards.ts src/transform/boards.test.ts
git commit -m "feat(salesforce-import): attribute historical org gifts and registrations to affiliations"
```

---

## Task 9: Wire it into `runTransform`, write the review files

**Files:**
- Modify: `src/transform/index.ts:38-136, 152, 161, 193-212`
- Test: `src/transform/index.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–8.
- Produces: `affiliations` payloads; People payloads with the new columns and links; Donations and
  Event Registrations with `Attribution` / `Acting for`; per-affiliation seed rollups
  (`Attributed Giving`, `Attributed Gift Count`, `Last Attributed Gift`) and People
  `Organizational Giving`; two review files:
  - `data/review/email-classification.csv` — header
    `contactSfId,name,email,domain,candidateAffiliations`; one row per unknown-domain secondary
    address; `candidateAffiliations` is `afSfId:Org Name` entries joined by `;`.
  - `data/review/unaffiliated-org-gifts.csv` — header
    `opportunitySfId,contactSfId,orgSfId,orgName,amount,closeDate`.
  Reads `data/enrich/email-kinds.csv` (Task 4's format) when present.
  Report warnings: `emails: N work, N household, N review, N swapped` and
  `attribution: N gifts and N registrations attributed; N org gifts have no affiliation (see data/review/unaffiliated-org-gifts.csv)`.

- [ ] **Step 1: Update the integration test**

In `src/transform/index.test.ts`, change `seed()`:

```ts
  await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
    { Id: 'c1', FirstName: 'Ada', LastName: 'L', Email: 'ada@gmail.com', AccountId: 'a-ind', ...prov },
    { Id: 'c2', FirstName: 'Eva', LastName: 'M', Email: 'e@b.c', ...prov }, // email-only → excluded
    // Affiliation-only inclusion; secondary address is Beta Org's domain → work email on af1.
    { Id: 'c3', FirstName: 'Uma', LastName: 'N', AccountId: 'a-org', Email: 'uma@gmail.com',
      Secondary_Email__c: 'uma@beta.example', ...prov },
    // Shared household address with c1 → c1 is Household Primary (first by Id), c4 is not.
    { Id: 'c4', FirstName: 'Cal', LastName: 'L', Email: 'cal@gmail.com', Secondary_Email__c: 'ada@gmail.com',
      funraise__fr_ID__c: 'f4', ...prov },
  ]);
  await writeNdjson(dataPath('extract', 'accounts.ndjson'), [
    { Id: 'a-ind', Name: 'Ada L Household', npe01__SYSTEM_AccountType__c: 'One-to-One Individual', ...prov },
    { Id: 'a-org', Name: 'Acme', npe01__SYSTEM_AccountType__c: null, Type: 'Sponsor', ...prov },
    { Id: 'a-org2', Name: 'Beta Org', npe01__SYSTEM_AccountType__c: null, Type: 'Partner',
      Website: 'https://www.beta.example/', ...prov },
  ]);
  await writeNdjson(dataPath('extract', 'opportunities.ndjson'), [
    { Id: 'o1', Name: 'Membership 2026', Amount: 60, CloseDate: '2026-01-15', StageName: 'Posted',
      RecordType: { Name: 'Membership' }, npsp__Primary_Contact__c: 'c1', AccountId: 'a-ind', ...prov },
    { Id: 'o2', Name: 'Gift 2015', Amount: 25, CloseDate: '2015-06-01', StageName: 'Posted',
      RecordType: { Name: 'Donation' }, npsp__Primary_Contact__c: 'c1', AccountId: 'a-ind', ...prov },
    // Org gift driven by c3 at Beta Org → attributed to af1.
    { Id: 'o3', Name: 'Beta sponsorship', Amount: 500, CloseDate: '2024-02-02', StageName: 'Posted',
      RecordType: { Name: 'Sponsorship' }, npsp__Primary_Contact__c: 'c3', AccountId: 'a-org2', ...prov },
    // Org gift with a contact who has no affiliation there → review file, not attributed.
    { Id: 'o4', Name: 'Acme gift', Amount: 75, CloseDate: '2024-03-03', StageName: 'Posted',
      RecordType: { Name: 'Donation' }, npsp__Primary_Contact__c: 'c1', AccountId: 'a-org', ...prov },
  ]);
  // ... memberships unchanged ...
  await writeNdjson(dataPath('extract', 'affiliations.ndjson'), [
    { Id: 'af1', npe5__Contact__c: 'c3', npe5__Organization__c: 'a-org2', npe5__Role__c: 'Director',
      npe5__Status__c: 'Current', npe5__Primary__c: true, ...prov },
    { Id: 'af2', npe5__Contact__c: 'c3', npe5__Organization__c: 'a-org', npe5__Status__c: 'Former', ...prov },
    { Id: 'af3', npe5__Contact__c: 'c3', npe5__Organization__c: 'a-ind', ...prov },   // individual → dropped
  ]);
  await writeNdjson(dataPath('extract', 'registrations.ndjson'), [
    { Id: 'r1', funraise__Registrant__c: 'c3', funraise__Email__c: 'UMA@beta.example', ...prov },
  ]);
```

and drop `'registrations'` from the `for (const empty of [...])` list. Replace the first test's
Organization-link block and add assertions:

```ts
    // Organization link = own org Account ∪ CURRENT affiliation orgs; Former (af2 at Acme) is
    // still on the Affiliations board but off the person's Organization column... except c3's
    // own AccountId IS Acme, so Acme stays via that path. Beta via af1.
    const uma = bySf.get('c3')!;
    expect(uma.board).toBe('people-historical');
    const orgLink = uma.links!.find((l) => l.column === 'Organization')!;
    expect(orgLink.targetSfIds.slice().sort()).toEqual(['a-org', 'a-org2']);
    expect(uma.links!.find((l) => l.column === 'Affiliations')!.targetSfIds.slice().sort()).toEqual(['af1', 'af2']);
    expect(uma.columns['Personal Email']).toEqual({ email: 'uma@gmail.com', text: 'uma@gmail.com' });
    expect(uma.columns['Household Email']).toBeNull();                 // beta.example went to af1 as work
    expect(uma.columns['Organizational Giving']).toBe('500');

    const af1 = bySf.get('af1')!;
    expect(af1.board).toBe('affiliations');
    expect(af1.name).toBe('Uma N @ Beta Org');
    expect(af1.columns['Work Email']).toEqual({ email: 'uma@beta.example', text: 'uma@beta.example' });
    expect(af1.columns['Status']).toEqual({ label: 'Current' });
    expect(af1.columns['Attributed Giving']).toBe('500');
    expect(af1.columns['Attributed Gift Count']).toBe('1');
    expect(af1.columns['Last Attributed Gift']).toEqual({ date: '2024-02-02' });
    expect(bySf.get('af2')!.columns['Status']).toEqual({ label: 'Former' });
    expect(bySf.get('af3')).toBeUndefined();

    expect(bySf.get('o3')!.links).toContainEqual({ column: 'Acting for', targetSfIds: ['af1'] });
    expect(bySf.get('o3')!.columns['Attribution']).toEqual({ label: 'Auto' });
    expect(bySf.get('o4')!.columns['Attribution']).toEqual({ label: 'None' });
    expect(bySf.get('r1')!.links).toContainEqual({ column: 'Acting for', targetSfIds: ['af1'] });

    // Shared address: ada@gmail.com is c1's Personal Email and c4's Household Email. Household
    // Primary goes to the first Contact by Id whose HOUSEHOLD Email is the address — a Personal
    // Email match doesn't count, since Personal is by definition one person's mailbox — so c4.
    expect(bySf.get('c1')!.columns['Personal Email']).toEqual({ email: 'ada@gmail.com', text: 'ada@gmail.com' });
    expect('Household Primary' in bySf.get('c1')!.columns).toBe(false);
    expect(bySf.get('c4')!.columns['Household Email']).toEqual({ email: 'ada@gmail.com', text: 'ada@gmail.com' });
    expect(bySf.get('c4')!.columns['Household Primary']).toEqual({ checked: 'true' });
```

Also change the existing `expect(ada.columns['Lifetime Giving']).toBe('85')` to `'160'`: o4 is
an org gift whose Primary Contact is c1, and the Donor link (unchanged by this plan) already
credits Primary Contact gifts to the person — see the finding in the self-review. Then add:

```ts
    const review = readFileSync(dataPath('review', 'unaffiliated-org-gifts.csv'), 'utf8');
    expect(review).toContain('o4,c1,a-org,Acme,75,2024-03-03');
    expect(existsSync(dataPath('review', 'email-classification.csv'))).toBe(false);   // nothing unknown this run
    expect(report.warnings.some((w) => w.startsWith('emails: 1 work, 1 household, 0 review, 0 swapped'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('1 org gifts have no affiliation'))).toBe(true);
```

(import `readFileSync`, `existsSync` from `node:fs`.) Add a second new test:

```ts
  it('writes unknown-domain secondaries to the review file and honors email-kinds overrides', async () => {
    await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
      { Id: 'c1', FirstName: 'Ada', LastName: 'L', Email: 'a@gmail.com', Secondary_Email__c: 'a@startup.io', funraise__fr_ID__c: 'f1', ...prov },
      { Id: 'c2', FirstName: 'Bo', LastName: 'M', Email: 'b@gmail.com', Secondary_Email__c: 'b@mystery.org', funraise__fr_ID__c: 'f2', ...prov },
    ]);
    await writeNdjson(dataPath('extract', 'affiliations.ndjson'), [
      { Id: 'af1', npe5__Contact__c: 'c1', npe5__Organization__c: 'a-org', ...prov },
    ]);
    await writeFile(dataPath('enrich', 'email-kinds.csv'), 'email,kind,affiliationSfId\na@startup.io,work,af1\n');
    expect(await runTransform(['--no-consent'])).toBe(0);
    const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
    const bySf = new Map(payloads.map((p) => [p.sfId, p]));
    expect(bySf.get('af1')!.columns['Work Email']).toEqual({ email: 'a@startup.io', text: 'a@startup.io' });
    expect(bySf.get('c2')!.columns['Household Email']).toEqual({ email: 'b@mystery.org', text: 'b@mystery.org' });
    const review = readFileSync(dataPath('review', 'email-classification.csv'), 'utf8');
    expect(review).toBe('contactSfId,name,email,domain,candidateAffiliations\nc2,Bo M,b@mystery.org,mystery.org,\n');
  });
```

(`writeFile` from `node:fs/promises`; `mkdir` the `data/enrich` dir first with
`await mkdir(dataPath('enrich'), { recursive: true })`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/transform/index.test.ts`
Expected: FAIL — no `affiliations` payloads, old titles.

- [ ] **Step 3: Wire `runTransform`**

Add imports at the top of `src/transform/index.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_CONSUMER_DOMAINS, websiteDomain } from './emailKind.js';
import { assignEmails, parseEmailKindOverrides, type AffiliationRef, type EmailOverride } from './emails.js';
import { affiliationToPayload, affiliationStatus } from './affiliations.js';
import { AffiliationIndex, attributeOpportunity, attributeRegistration, attributionRollups, type AffiliationEntry } from './attribution.js';
```

Replace the block from `const affiliationOrgsByContact = ...` through the end of the contacts loop
(`payloads.push(r ? applyRollups(p, r) : p); }`) with:

```ts
  // ---- Affiliations: one item per person-at-organization tenure (spec: affiliation model) ----
  const orgAffiliations = affiliations.filter((a) =>
    a['npe5__Contact__c'] && a['npe5__Organization__c'] && orgAccountIds.has(a['npe5__Organization__c'] as string));
  const affiliationsByContact = new Map<string, Record<string, unknown>[]>();
  for (const a of orgAffiliations) {
    const contactId = a['npe5__Contact__c'] as string;
    (affiliationsByContact.get(contactId) ?? affiliationsByContact.set(contactId, []).get(contactId)!).push(a);
  }
  const accountById = new Map(accounts.map((a) => [a['Id'] as string, a]));
  const orgDomainByOrgId = new Map<string, string>();
  for (const a of accounts) {
    if (!orgAccountIds.has(a['Id'] as string)) continue;
    const site = (a['Website'] as string | null) || enrichment.get(a['Id'] as string)?.website || null;
    const domain = websiteDomain(site);
    if (domain) orgDomainByOrgId.set(a['Id'] as string, domain);
  }
  const consumerDomains = new Set(cfg.consumerEmailDomains ?? DEFAULT_CONSUMER_DOMAINS);
  const overridesPath = dataPath('enrich', 'email-kinds.csv');
  const overrides: Map<string, EmailOverride> = existsSync(overridesPath)
    ? parseEmailKindOverrides(readFileSync(overridesPath, 'utf8')) : new Map();

  const rollups = { map: donorRollups(opportunities, cnpUnique), cnpUnique,
    overlap: cnp.length - cnpUnique.length };

  // Pass A: classify every included contact's addresses. Sorted by Id so "first person with a
  // given Household Email" is deterministic run to run.
  const assignments = new Map<string, ReturnType<typeof assignEmails>>();
  const boardOf = new Map<string, 'people-live' | 'people-historical'>();
  const emailStats = { work: 0, household: 0, review: 0, swapped: 0 };
  const emailReviewRows: string[] = [];
  const sortedContacts = [...contacts].sort((x, y) => String(x['Id']).localeCompare(String(y['Id'])));
  for (const c of sortedContacts) {
    const board = classifyContact(c, inc, cfg.peopleActiveSinceISO);
    if (!board) continue;
    const id = c['Id'] as string;
    boardOf.set(id, board);
    const refs: AffiliationRef[] = (affiliationsByContact.get(id) ?? []).map((a) => ({
      sfId: a['Id'] as string, orgSfId: a['npe5__Organization__c'] as string, primary: a['npe5__Primary__c'] === true }));
    const asg = assignEmails(c, refs, orgDomainByOrgId, consumerDomains, overrides);
    assignments.set(id, asg);
    emailStats.work += asg.work.size;
    if (asg.household) emailStats.household++;
    if (asg.swapped) emailStats.swapped++;
    for (const r of asg.review) {
      emailStats.review++;
      const name = [c['FirstName'], c['LastName']].filter(Boolean).join(' ');
      const candidates = refs.map((ref) => `${ref.sfId}:${accountById.get(ref.orgSfId)?.['Name'] ?? ''}`).join(';');
      emailReviewRows.push([id, name, r.email, r.domain, candidates].join(','));
    }
  }
  const householdPrimaryOf = new Map<string, string>();   // household email → first contact Id
  for (const c of sortedContacts) {
    const asg = assignments.get(c['Id'] as string);
    if (asg?.household && !householdPrimaryOf.has(asg.household)) householdPrimaryOf.set(asg.household, c['Id'] as string);
  }

  // Pass B: the affiliation index (work emails + tenures) drives attribution of gifts and
  // registrations before any payload is built, so seed rollups can land on both sides.
  const affiliationEntries: AffiliationEntry[] = orgAffiliations
    .filter((a) => boardOf.has(a['npe5__Contact__c'] as string))
    .map((a) => ({
      sfId: a['Id'] as string, contactSfId: a['npe5__Contact__c'] as string, orgSfId: a['npe5__Organization__c'] as string,
      startISO: (a['npe5__StartDate__c'] as string | null) ?? null, endISO: (a['npe5__EndDate__c'] as string | null) ?? null,
      primary: a['npe5__Primary__c'] === true,
      workEmail: assignments.get(a['npe5__Contact__c'] as string)?.work.get(a['Id'] as string) ?? null }));
  const affiliationIndex = new AffiliationIndex(affiliationEntries);
  const attributedOpps = new Map<string, string>();
  const unaffiliatedRows: string[] = [];
  for (const o of opportunities) {
    const att = attributeOpportunity(o, affiliationIndex, orgAccountIds);
    if (att && 'affiliationSfId' in att) attributedOpps.set(o['Id'] as string, att.affiliationSfId);
    else if (att && 'unaffiliated' in att) {
      unaffiliatedRows.push([o['Id'], att.unaffiliated.contactSfId, att.unaffiliated.orgSfId,
        accountById.get(att.unaffiliated.orgSfId)?.['Name'] ?? '', o['Amount'] ?? '', String(o['CloseDate'] ?? '').slice(0, 10)].join(','));
    }
  }
  const attributedRegs = new Map<string, string>();
  for (const r of registrations) {
    const af = attributeRegistration(r, affiliationIndex);
    if (af) attributedRegs.set(r['Id'] as string, af);
  }
  const attRollups = attributionRollups(opportunities, attributedOpps, affiliationIndex);

  const payloads: ItemPayload[] = [];
  const includedContactIds = new Set<string>();

  for (const c of sortedContacts) {
    const id = c['Id'] as string;
    const board = boardOf.get(id);
    if (!board) continue;
    includedContactIds.add(id);
    const asg = assignments.get(id)!;
    const geoKey = normalizeAddress({ street: c['MailingStreet'] as string, city: c['MailingCity'] as string,
      state: c['MailingState'] as string, zip: c['MailingPostalCode'] as string });
    const myAffiliations = affiliationsByContact.get(id) ?? [];
    let p = contactToPayload(c, board, { consent, member: memberSummaries.get(id),
      geo: geoKey ? geoCache.get(geoKey) : undefined,
      emails: { personal: asg.personal, household: asg.household },
      householdPrimary: asg.household !== null && householdPrimaryOf.get(asg.household) === id,
      affiliationSfIds: myAffiliations.map((a) => a['Id'] as string) });
    // Organization link = the Contact's own org Account (if any) ∪ its CURRENT affiliation orgs.
    // Former tenures live on the Affiliations board, not on the person's Organization column.
    const currentOrgs = myAffiliations.filter((a) => affiliationStatus(a['npe5__Status__c']) === 'Current')
      .map((a) => a['npe5__Organization__c'] as string);
    const ownOrg = (p.links ?? []).flatMap((l) => l.column === 'Organization' ? l.targetSfIds : [])
      .filter((oid) => orgAccountIds.has(oid));
    const orgTargets = [...new Set([...ownOrg, ...currentOrgs])];
    p = { ...p, links: [
      ...(p.links ?? []).filter((l) => l.column !== 'Organization'),
      ...(orgTargets.length > 0 ? [{ column: 'Organization', targetSfIds: orgTargets }] : []),
    ] };
    const orgGiving = attRollups.organizationalGivingByContact.get(id);
    if (orgGiving !== undefined) p.columns['Organizational Giving'] = String(orgGiving);
    const r = rollups.map.get(id);
    payloads.push(r ? applyRollups(p, r) : p);
  }
  for (const a of orgAffiliations) {
    const contactId = a['npe5__Contact__c'] as string;
    if (!boardOf.has(contactId)) continue;   // contact not migrated → no dangling tenure
    const c = contacts.find((x) => x['Id'] === contactId)!;
    const p = affiliationToPayload(a, {
      personName: [c['FirstName'], c['LastName']].filter(Boolean).join(' ') || '(no name)',
      orgName: (accountById.get(a['npe5__Organization__c'] as string)?.['Name'] as string) ?? '(no name)',
      workEmail: assignments.get(contactId)?.work.get(a['Id'] as string) ?? null, consent });
    const ar = attRollups.byAffiliation.get(a['Id'] as string);
    if (ar) {
      p.columns['Attributed Giving'] = String(ar.giving);
      p.columns['Attributed Gift Count'] = String(ar.giftCount);
      p.columns['Last Attributed Gift'] = ar.lastGiftISO ? { date: ar.lastGiftISO } : null;
    }
    payloads.push(p);
  }
```

Replace `contacts.find(...)` with a `contactById` map built once (`new Map(contacts.map(...))`)
— the `find` is O(n²) over 15k contacts.

Change the two payload lines further down:

```ts
  for (const o of opportunities) payloads.push(opportunityToPayload(o, { termCols, actingFor: attributedOpps.get(o['Id'] as string) ?? null }));
  // ...
  for (const r of registrations) payloads.push(registrationToPayload(r, { actingFor: attributedRegs.get(r['Id'] as string) ?? null }));
```

Before `const report: TransformReport = {`, write the review files and warnings:

```ts
  await mkdir(dataPath('review'), { recursive: true });
  if (emailReviewRows.length > 0) {
    await writeFile(dataPath('review', 'email-classification.csv'),
      ['contactSfId,name,email,domain,candidateAffiliations', ...emailReviewRows].join('\n') + '\n', 'utf8');
  }
  await writeFile(dataPath('review', 'unaffiliated-org-gifts.csv'),
    ['opportunitySfId,contactSfId,orgSfId,orgName,amount,closeDate', ...unaffiliatedRows].join('\n') + '\n', 'utf8');
  warnings.push(`emails: ${emailStats.work} work, ${emailStats.household} household, ${emailStats.review} review, ` +
    `${emailStats.swapped} swapped` + (emailStats.review > 0 ? ' — see data/review/email-classification.csv' : ''));
  warnings.push(`attribution: ${attributedOpps.size} gifts and ${attributedRegs.size} registrations attributed; ` +
    `${unaffiliatedRows.length} org gifts have no affiliation (see data/review/unaffiliated-org-gifts.csv)`);
```

Remove the now-unused `affiliatedIds`-adjacent code only if the compiler flags it; `inc.affiliatedIds`
stays (it drives inclusion).

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, all files.

- [ ] **Step 5: Dry-run against real extract data if `data/extract/` exists locally**

```bash
npm run cli -- transform --no-consent && head -5 data/review/email-classification.csv && wc -l data/review/*.csv && grep -E '"emails|"attribution' data/transform/report.json
```

Record the four `emails:` numbers and the unaffiliated count in the commit message. If
`data/extract/` is absent (it is gitignored and was lost with the old worktree; see the parent
workspace `CLAUDE.md`), skip this step and say so in the commit.

- [ ] **Step 6: Commit**

```bash
git add src/transform/index.ts src/transform/index.test.ts
git commit -m "feat(salesforce-import): emit Affiliations, per-kind emails, attribution, and review files

Real-data dry run: emails <work> work, <household> household, <review> review, <swapped> swapped; <n> org gifts unaffiliated."
```

---

## Task 10: Document the new shape

**Files:**
- Modify: `README.md` (run sequence, "What the script must resolve", the 2026-08-21 scope
  paragraph at lines 100-106)
- Modify (private repo, separate commit there after this MR merges):
  `monday-migration/docs/06-staff-process-guide.md` People table (Task 10 Step 3 text)

- [ ] **Step 1: README run sequence**

After the `npm run cli -- transform` line in "Run sequence", add:

```
#   transform also writes data/review/email-classification.csv (secondary addresses on a domain
#   that is neither an affiliated org's nor a consumer mailbox — decide each one, copy rows into
#   data/enrich/email-kinds.csv as email,kind,affiliationSfId, re-run transform) and
#   data/review/unaffiliated-org-gifts.csv (org gifts whose primary contact has no Affiliation at
#   that org — create the Affiliation in Salesforce or accept the gift as organization-only).
```

- [ ] **Step 2: README scope paragraph**

Replace the sentence added on 2026-09-08 (`Secondary_Email__c` as its own labeled column …
per person)) with:

```
`npe5__Affiliation__c` as its own **Affiliations** board (one item per person-at-organization
tenure: Role, Status, Start/End, Primary, and the Work Email that address-classification assigns
to it, with its own consent status); People carry **Personal Email** and **Household Email**, each
with its own consent status, plus **Household Primary** for a shared address; Donations and Event
Registrations carry **Acting for** (→ Affiliations) and **Attribution** (Auto / Staff / Needs
review / None), attributed at import from NPSP's org-gift shape and from registration emails;
design in `docs/superpowers/specs/2026-09-08-person-org-email-model-design.md`
```

- [ ] **Step 3: Staff guide text (private repo, after merge)**

In `docs/06-staff-process-guide.md` People table, replace the Email / Secondary Email row and the
two consent rows with:

```
| Personal Email / Household Email | email | the person's own mailbox, and a shared family address if they have one. A work address lives on the Affiliations board, not here |
| Personal Email Consent / Household Email Consent | status | Subscribed / Unsubscribed / Cleaned / Not in Mailchimp, one per address — consent belongs to the address, not the person |
| Household Primary | checkbox | on a shared household address, whose details the Mailchimp contact shows |
| Affiliations | connect → Affiliations | every organization this person has represented, with role and dates — open one to see what they drove there |
| Organizational Giving | numbers | gifts this person drove through organizations they represented, across all their affiliations. Their personal giving is in Lifetime Giving |
```

and add an "Affiliations board" subsection after Organizations describing the columns from
Task 5/7's table. Do this as its own commit in `monday-migration` once this MR merges, so the
staff guide never describes a board the sandbox doesn't have.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(salesforce-import): describe the Affiliations board, email kinds, and review files"
```

---

## Self-review against the spec

- **Affiliations board columns** — Role, Status, Start, End, Primary, Work Email, Work Email
  Consent, Salesforce Debug, Person, Organization: Tasks 5, 7. Attributed Giving / Gift Count /
  Last Attributed Gift seeded here (Task 8/9), maintained by Plan 2. Attributed Registrations /
  Volunteer Hours / Activities: **not seeded here** — Plan 2 computes them from the boards; only
  gifts have a historical attribution signal rich enough to seed.
- **People changes** — Personal/Household Email + consent, Household Primary, Affiliations link,
  derived Organization link, Organizational Giving: Tasks 6, 9. Column renames on existing boards:
  Task 7 (in place via API, so the spec's "UI step" prerequisite disappears).
- **Impact boards** — Acting for + Attribution on Donations and Event Registrations: Task 8. On
  Volunteers and Activities there is no historical signal (no email, no org on the record), so
  those two columns are created by Plan 3 alongside the resolver, not here.
- **Migration §1–5** — extract fields (Task 1), Affiliation payloads (5, 9), email classification
  with the three branches, the one swap, and the review/override files (3, 4, 9), load
  provisioning (7), consent per address (5, 6).
- **Testing section** — migration items covered: three classification branches and the swap
  (Task 4), dropped Affiliation for a non-migrated contact (Task 9's `af3` and `boardOf` filter).
- **Finding that touches the spec's premise** — `opportunityToPayload` links Donor to
  `npsp__Primary_Contact__c` first and `AccountId` only as a fallback, and `donorRollups` keys the
  same way. So an NPSP org gift *with* a primary contact already rolls up to the **person's**
  Lifetime Giving today, and the organization gets nothing for it; the spec's "a sponsorship paid
  by Apple rolls up to Apple" is only true for org gifts with no primary contact. This plan leaves
  that rule alone (Global Constraints) and layers attribution on top, which means for those gifts
  Lifetime Giving and Organizational Giving overlap. Decide before Plan 2 whether the Donor link
  for an org-Account Opportunity should become the organization (with the person reachable via
  Acting for), which is what the spec's Organizations section assumes.
- **Type consistency** — `AffiliationRef` (emails.ts) vs `AffiliationEntry`/`Tenure`
  (attribution.ts/affiliations.ts) are deliberately different: the first is what classification
  needs (org + primary), the second what attribution needs (dates + work email). `consentLabel`
  is defined in Task 5 and used in Tasks 5 and 6. `attributionColumns` is used by both payload
  builders in Task 8 and nowhere else. `pickAffiliation` is generic over `Tenure` so
  `AffiliationEntry` satisfies it.
