#!/usr/bin/env node
// Checks that the staff "Enter a gift" form on the Donations board still shows only the questions
// it should and still requires a monday login. Read-only: one `form` query per token.
//
//   MONDAY_API_TOKEN=... node scripts/check-donation-form.mjs --form 567223ac739c23567e56e9057d81dbf5
//   MONDAY_API_TOKEN=... node scripts/check-donation-form.mjs --form <production> --form <sandbox>
//
// The form token is the string after /forms/ in the form's share link. Run it after adding or
// renaming a column on the Donations board, and after creating a new form view (which defaults to
// public). Exit 0: every form matches. Exit 1: a form shows something it should not (listed).
// Exit 2: usage or API error. The rules and the reason are in scripts/lib/donation-form.mjs.

import { fileURLToPath } from 'node:url';
import { MONDAY_API_VERSION } from '../monday-backup/src/monday/graphql.ts';
import { checkForm } from './lib/donation-form.mjs';

const API_URL = 'https://api.monday.com/v2';

export function parseArgs(argv) {
  const forms = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--form') throw new Error(`unknown argument "${argv[i]}"`);
    const token = argv[++i];
    if (token === undefined) throw new Error('--form needs a form token');
    if (!/^[0-9a-f]{32}$/.test(token)) throw new Error(`--form token must be 32 hex characters, got "${token}"`);
    forms.push(token);
  }
  if (forms.length === 0) throw new Error('at least one --form <token> is required');
  return { forms };
}

async function fetchForm(token, formToken) {
  // showIfRules is named show_if_rules from API version 2026-10.
  const graphql = `{ form(formToken: "${formToken}") { token active questions { id type title visible required showIfRules options { label value visible } } features { requireLogin { enabled } } } }`;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': MONDAY_API_VERSION },
    body: JSON.stringify({ query: graphql }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body === null || body.errors || !body.data?.form) {
    throw new Error(`monday API: HTTP ${res.status}: ${JSON.stringify(body?.errors ?? body?.error_message ?? body).slice(0, 300)}`);
  }
  return body.data.form;
}

async function main() {
  const token = process.env.MONDAY_API_TOKEN;
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!token) throw new Error('MONDAY_API_TOKEN is not set');
  } catch (err) {
    console.error(`${err.message}\nusage: MONDAY_API_TOKEN=... node scripts/check-donation-form.mjs --form <token> [--form <token> ...]`);
    return 2;
  }
  let failed = false;
  for (const formToken of args.forms) {
    let form;
    try {
      form = await fetchForm(token, formToken);
    } catch (err) {
      console.error(err.cause ? `${err.message}: ${err.cause.message ?? err.cause}` : err.message);
      return 2;
    }
    const problems = checkForm(form);
    if (problems.length === 0) {
      console.log(`OK   ${formToken}`);
    } else {
      failed = true;
      console.log(`FAIL ${formToken}`);
      for (const p of problems) console.log(`  - ${p}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
