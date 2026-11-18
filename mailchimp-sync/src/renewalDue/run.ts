// Daily run of the renewal-due tag (plan.ts), on the Campaigns reconcile's cron. Stateless: every
// run recomputes the tag for the whole audience from Member Until and the active-member tag, so a
// missed day is caught up by the next, and a member who entered the window on the missed day is
// tagged a day late rather than not at all.
//
// Follows the write switch like the other crons: `hold`/`unknown` skip the day, `off` plans and
// logs without writing. Logs carry counts only, never an address.
import { runDisposition, type WriteMode } from '../flags';
import type { BatchSkipContext } from '../writeSwitch';
import type { Config } from '../types';
import { memberId, redactEmails } from '../logSafe';
import { planRenewalDue, todayIn, type RenewalMember } from './plan';

export interface RenewalDueDeps {
  config: Config;
  fetchFn: typeof fetch;
  apiKey: string;
  now?: () => Date;
}

export interface RenewalDueSummary {
  outcome: 'disabled' | 'skipped' | 'read-failed' | 'done';
  mode: WriteMode;
  members: number;
  due: number;
  added: number;
  removed: number;
  failed: number;
  dryRun: boolean;
}

const PAGE = 1000;
const REQUEST_TIMEOUT_MS = 20_000;
// A normal day adds and removes a handful; this bounds a first run or a bad date import. The rest
// is picked up the next day.
export const RENEWAL_DUE_MAX_CHANGES = 1000;
const TIME_ZONE = 'America/Los_Angeles';

async function readMembers(deps: RenewalDueDeps, untilField: string): Promise<RenewalMember[]> {
  const { apiBaseUrl, audienceId } = deps.config.mailchimp;
  const auth = `Basic ${btoa(`anystring:${deps.apiKey}`)}`;
  const fields = `total_items,members.email_address,members.status,members.tags,members.merge_fields.${untilField}`;
  const members: RenewalMember[] = [];
  let total: number | null = null;
  for (let offset = 0; total === null || offset < total; offset += PAGE) {
    const params = new URLSearchParams({ count: String(PAGE), offset: String(offset), fields });
    const res = await deps.fetchFn(`${apiBaseUrl}/lists/${audienceId}/members?${params}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`list members: HTTP ${res.status} at offset ${offset}`);
    const page = (await res.json()) as { total_items: number; members: RenewalMember[] };
    // Offset paging shifts if a member is added or archived mid-read; a member skipped would keep
    // or miss the tag for a day, so start over tomorrow instead.
    if (total !== null && page.total_items !== total) throw new Error(`audience changed while paging (${total} → ${page.total_items})`);
    total = page.total_items;
    members.push(...page.members);
    if (page.members.length === 0) break;
  }
  if (members.length !== total) throw new Error(`read ${members.length} of ${total} members`);
  return members;
}

async function setTag(deps: RenewalDueDeps, email: string, tag: string, active: boolean): Promise<void> {
  const { apiBaseUrl, audienceId } = deps.config.mailchimp;
  const res = await deps.fetchFn(`${apiBaseUrl}/lists/${audienceId}/members/${memberId(email)}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa(`anystring:${deps.apiKey}`)}` },
    body: JSON.stringify({ tags: [{ name: tag, status: active ? 'active' : 'inactive' }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`tag member ${memberId(email)}: HTTP ${res.status}`);
}

export async function runRenewalDue(gate: BatchSkipContext, deps: RenewalDueDeps): Promise<RenewalDueSummary> {
  const { config } = deps;
  const settings = config.mailchimp.renewalDue;
  const summary: RenewalDueSummary = { outcome: 'done', mode: gate.mode, members: 0, due: 0, added: 0, removed: 0, failed: 0, dryRun: false };
  const prefix = `mailchimp-sync renewal-due (${gate.environment}):`;
  if (settings === null) return { ...summary, outcome: 'disabled' };
  const disposition = runDisposition(gate.mode);
  if (disposition === 'skip') {
    console.warn(`${prefix} write mode is "${gate.mode}"; skipping today's run`);
    return { ...summary, outcome: 'skipped' };
  }

  let members: RenewalMember[];
  try {
    members = await readMembers(deps, config.mailchimp.mergeFields.memberUntil);
  } catch (err) {
    console.error(`${prefix} the Mailchimp read failed; nothing written today: ${redactEmails((err as Error).message)}`);
    return { ...summary, outcome: 'read-failed' };
  }
  const today = todayIn(TIME_ZONE, (deps.now ?? (() => new Date()))());
  const plan = planRenewalDue(members, {
    activeTag: config.mailchimp.tags.activeMember,
    dueTag: settings.tag,
    untilField: config.mailchimp.mergeFields.memberUntil,
    daysBefore: settings.daysBefore,
    today,
  });
  summary.members = members.length;
  summary.due = plan.due;

  const changes = [...plan.add.map((email) => ({ email, active: true })), ...plan.remove.map((email) => ({ email, active: false }))]
    .slice(0, RENEWAL_DUE_MAX_CHANGES);
  if (disposition === 'dry-run') {
    summary.dryRun = true;
    console.log(`${prefix} dry run (writes ${gate.mode}) for ${today}: ${plan.due} due; would add ${plan.add.length}, remove ${plan.remove.length}`);
    return summary;
  }
  for (const change of changes) {
    try {
      await setTag(deps, change.email, settings.tag, change.active);
      if (change.active) summary.added += 1;
      else summary.removed += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(`${prefix} ${redactEmails((err as Error).message)}`);
    }
  }
  const held = plan.add.length + plan.remove.length - changes.length;
  console.log(`${prefix} ${today}: ${members.length} members, ${plan.due} due; added ${summary.added}, removed ${summary.removed}, failed ${summary.failed}${held > 0 ? `, ${held} left for tomorrow (cap ${RENEWAL_DUE_MAX_CHANGES})` : ''}`);
  return summary;
}
