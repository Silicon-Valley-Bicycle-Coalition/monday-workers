#!/usr/bin/env node
// Ports the renewal-reminder and new-member-welcome email templates Salesforce's
// Scheduled_Membership_Emails flow sent (scripts/port-salesforce-templates-lib.mjs TEMPLATES) into
// Mailchimp as custom-coded templates for the Customer Journeys to use. Reads Salesforce's
// EmailTemplate through the `sf` CLI. Salesforce merge fields become Mailchimp merge tags
// (*|FNAME|* with a "friend" fallback, *|MEMBUNTIL|*), and every template is wrapped in the design
// system's EmailLayout (black header band with the wordmark) with the unsubscribe link and postal
// address Mailchimp needs before it sends.
//
// DRY RUN BY DEFAULT: writes each converted template to --out for review, prints the subject line
// to set on each Journey email and any copy changes, and writes nothing to Mailchimp. --apply
// creates each template in Mailchimp, or replaces the HTML of one already there by the same name.
// A template edited in Mailchimp is overwritten by a later --apply.
//
// The header wordmark is hosted in Mailchimp's own file manager (mcusercontent.com): --apply
// uploads docs/design-system/assets/Logos/svbc-wordmark-email.png once, reuses it by name after,
// and points the templates at it. Not member-portal's /email/logo.png: bikesiliconvalley.org's
// Super Bot Fight Mode challenges data-centre clients, which Mailchimp's preview renderer and
// inbox image proxies are, so the header showed as a broken image (2026-11-17).
//
// Usage (from mailchimp-sync/):
//   [MAILCHIMP_API_KEY=...] node scripts/port-salesforce-templates.mjs --env production|sandbox
//     [--org svbc]        Salesforce CLI alias (default svbc; the templates exist only there)
//     [--out dir]         where to write the converted HTML (default ./salesforce-templates)
//     [--logo-url url]    header wordmark PNG to use instead of uploading one to Mailchimp
//     [--apply]           needs MAILCHIMP_API_KEY
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGO_URL, TEMPLATES, convertTemplate } from './port-salesforce-templates-lib.mjs';

const LOGO_FILE = fileURLToPath(new URL('../../docs/design-system/assets/Logos/svbc-wordmark-email.png', import.meta.url));

const CONFIG_FILES = { sandbox: 'sandbox.json', production: 'svbc.json' };
const argIdx = (name) => process.argv.indexOf(name);
const argValue = (name, dflt) => (argIdx(name) >= 0 ? process.argv[argIdx(name) + 1] : dflt);

function usage(message) {
  console.error(`${message}\nusage: node scripts/port-salesforce-templates.mjs --env production|sandbox [--org alias] [--out dir] [--logo-url url] [--apply]`);
  process.exit(2);
}

function readTemplates(org) {
  const names = TEMPLATES.map((t) => `'${t.developerName}'`).join(',');
  const soql = `SELECT DeveloperName, Subject, HtmlValue FROM EmailTemplate WHERE DeveloperName IN (${names})`;
  const out = execFileSync('sf', ['data', 'query', '--target-org', org, '--json', '-q', soql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const { status, result, message } = JSON.parse(out);
  if (status !== 0) throw new Error(`sf data query failed: ${message}`);
  const byName = new Map(result.records.map((r) => [r.DeveloperName, r]));
  const missing = TEMPLATES.filter((t) => !byName.has(t.developerName)).map((t) => t.developerName);
  if (missing.length) throw new Error(`not in Salesforce org ${org}: ${missing.join(', ')}`);
  return byName;
}

function mailchimpTemplates(apiBaseUrl, apiKey) {
  const headers = { Authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`, 'Content-Type': 'application/json' };
  async function call(method, path, body) {
    const res = await fetch(apiBaseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Mailchimp ${method} ${path}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  return {
    async byName() {
      const { templates } = await call('GET', '/templates?type=user&count=1000&fields=templates.id,templates.name');
      return new Map(templates.map((t) => [t.name, t.id]));
    },
    create: (name, html) => call('POST', '/templates', { name, html }),
    // The file manager's URL for an image by name, uploading it first if it isn't there.
    async hostedImage(path) {
      const name = basename(path);
      const { files } = await call('GET', '/file-manager/files?type=image&count=1000&fields=files.name,files.full_size_url');
      const found = files.find((f) => f.name === name);
      if (found) return { url: found.full_size_url, uploaded: false };
      const saved = await call('POST', '/file-manager/files', { name, file_data: readFileSync(path).toString('base64') });
      return { url: saved.full_size_url, uploaded: true };
    },
    update: (id, name, html) => call('PATCH', `/templates/${id}`, { name, html }),
  };
}

async function main() {
  const envName = argValue('--env');
  if (!envName || !(envName in CONFIG_FILES)) usage('--env is required');
  const apply = argIdx('--apply') >= 0;
  if (apply && !process.env.MAILCHIMP_API_KEY) usage('--apply needs MAILCHIMP_API_KEY');
  const org = argValue('--org', 'svbc');
  const outDir = argValue('--out', 'salesforce-templates');
  const config = JSON.parse(readFileSync(fileURLToPath(new URL(`../config/${CONFIG_FILES[envName]}`, import.meta.url)), 'utf8'));
  const mc = apply ? mailchimpTemplates(config.mailchimp.apiBaseUrl, process.env.MAILCHIMP_API_KEY) : null;

  let logoUrl = argValue('--logo-url', undefined);
  if (!logoUrl && mc) {
    const logo = await mc.hostedImage(LOGO_FILE);
    logoUrl = logo.url;
    console.log(`Header logo ${logo.uploaded ? 'uploaded to' : 'already in'} the Mailchimp file manager: ${logoUrl}\n`);
  } else if (!logoUrl) {
    console.log(`Dry run previews use ${LOGO_URL}; --apply hosts the logo in Mailchimp instead.\n`);
  }

  const source = readTemplates(org);
  mkdirSync(outDir, { recursive: true });
  const converted = TEMPLATES.map((t) => {
    const { Subject, HtmlValue } = source.get(t.developerName);
    const { html, notes } = convertTemplate(HtmlValue ?? '', t.name, logoUrl);
    const file = join(outDir, `${t.developerName}.html`);
    writeFileSync(file, html);
    console.log(`${t.name}\n  from Salesforce ${t.developerName} → ${file}\n  subject: ${Subject}`);
    for (const n of notes) console.log(`  copy change: ${n}`);
    return { ...t, html };
  });

  if (!apply) {
    console.log(`\nDry run: nothing written to Mailchimp. Review ${outDir}/, then re-run with --apply.`);
    return;
  }
  const existing = await mc.byName();
  console.log(`\nMailchimp (${envName}):`);
  for (const t of converted) {
    const id = existing.get(t.name);
    const saved = id ? await mc.update(id, t.name, t.html) : await mc.create(t.name, t.html);
    console.log(`  ${id ? 'updated' : 'created'} template ${saved.id}: ${t.name}`);
  }
}

main().catch((err) => {
  console.error(`port-salesforce-templates: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
  process.exit(1);
});
