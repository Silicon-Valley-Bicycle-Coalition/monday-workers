import type { DtdSyncConfig, OutreachConfig } from '../config';
import { todayLosAngeles } from '../dates';
import {
  claimPrompt, itemsKnownToDtd, markPromptFailed, markPromptSent, markPromptWritten, promptedDonors, promptRows, releasePrompt,
  stuckPrompts, unwrittenPrompts,
} from '../db/prompts';
import { logItemFailure } from '../logSafe';
import { PROMPTED_LABEL, promptDecision, windowFloor, type PromptFacts } from '../mapping/eligibility';
import type { DonationItem, DtdMondayClient, PromptDonor } from '../monday/client';
import { renderPromptEmail } from '../outreach/email';
import { classifySendError, sendErrorCode } from '../outreach/sendErrors';
import { MATCHING_GIFT_TYPE } from '../pairing/pair';

export interface PromptDeps { monday: DtdMondayClient; db: D1Database; config: DtdSyncConfig; email: SendEmail; dryRun: boolean }
export interface PromptResult { considered: number; sent: number; failed: number; repaired: number }

const DAY_MS = 86_400_000;
// A pending row this old belongs to a run that died, not one still sending.
const STUCK_AFTER_MS = 30 * 60_000;
// Each send is about five subrequests (three D1, the email, Monday); Cloudflare allows 1,000 a run.
const MAX_SENDS_PER_RUN = 100;

/** Match Prompt Sent, plus Prompted when Match Status is empty: never over Matched or a DTD status. */
function promptValues(item: DonationItem, sentAt: Date, config: DtdSyncConfig, outreach: OutreachConfig): Record<string, unknown> {
  return {
    [outreach.donations.matchPromptSent]: { date: todayLosAngeles(sentAt) },
    ...(item.matchStatus === null ? { [config.donations.matchStatus]: { label: PROMPTED_LABEL } } : {}),
  };
}

// Sent emails Monday doesn't show yet. An item that's gone has nothing to show, so it is settled too.
async function repair(deps: PromptDeps, outreach: OutreachConfig, now: Date): Promise<number> {
  const { monday, db, config } = deps;
  const rows = await unwrittenPrompts(db);
  if (rows.length === 0) return 0;
  const items = new Map((await monday.getDonations(rows.map((r) => r.mondayItemId))).map((i) => [i.id, i]));
  let repaired = 0;
  for (const row of rows) {
    try {
      const item = items.get(row.mondayItemId);
      if (item !== undefined) {
        await monday.updateDonation(item.id, promptValues(item, new Date(row.sentAt ?? row.claimedAt), config, outreach));
        repaired++;
      }
      await markPromptWritten(db, row.mondayItemId, now.toISOString());
    } catch (err) {
      logItemFailure('prompt repair', row.mondayItemId, err);
    }
  }
  return repaired;
}

/** Records a failed send. True when the run must stop: nothing can send, or this email's fate is unknown. */
async function handleSendFailure(db: D1Database, itemId: string, err: unknown): Promise<boolean> {
  const kind = classifySendError(err);
  logItemFailure('prompt', itemId, err);
  if (kind === 'rejected') {
    await markPromptFailed(db, itemId, err instanceof Error ? err.message : 'unknown error');
    return false;
  }
  if (kind === 'stop') {
    await releasePrompt(db, itemId);
    console.log(`dtd-sync: prompt stopped ${sendErrorCode(err)}`);
    return true;
  }
  // Left pending: never retried, and it counts toward the donor's cooldown.
  console.log(`dtd-sync: prompt item ${itemId} may have been sent`);
  return true;
}

/**
 * Email each eligible donor once about an employer match (docs/superpowers/specs/
 * 2026-11-16-post-gift-match-email-design.md). The prompts row is claimed before the send and
 * Monday is written after it, so no failure can send a gift's email twice: a row left pending may
 * have been sent, and is reported, never retried.
 */
export async function runPrompt(deps: PromptDeps, now: Date): Promise<PromptResult> {
  const { monday, db, config, email, dryRun } = deps;
  const { outreach } = config;
  if (outreach === null || outreach.mode !== 'email') throw new Error('prompt: config.outreach is not in email mode');
  const cfg = config.push;
  const nowISO = now.toISOString();

  let repaired = 0;
  if (!dryRun) {
    try {
      repaired = await repair(deps, outreach, now);
    } catch (err) {
      logItemFailure('prompt', 'repair', err);
    }
  }
  for (const id of await stuckPrompts(db, new Date(now.getTime() - STUCK_AFTER_MS).toISOString())) console.log(`dtd-sync: prompt item ${id} stuck`);

  const floor = windowFloor(cfg, now);
  const items = await monday.listDonationsDatedSince(floor);
  // A match can't predate its gift, so the gift window covers every match that matters here.
  const matches = await monday.listDonationsOfTypeDatedSince(MATCHING_GIFT_TYPE, floor);
  const pairedGiftIds = new Set(matches.flatMap((m) => (m.matchesGiftItemId === null ? [] : [m.matchesGiftItemId])));

  const open: PromptFacts = { pairedGiftIds, knownToDtd: false, inCooldown: false };
  const candidates = items.filter((i) => {
    const d = promptDecision(i, null, cfg, outreach, open, now);
    return !d.send && d.reason === 'no-email';
  });
  const donorIds = [...new Set(candidates.flatMap((i) => (i.donorItemId === null ? [] : [i.donorItemId])))];
  const donors = new Map<string, PromptDonor>();
  if (donorIds.length > 0) for (const p of await monday.getPromptDonors(donorIds)) donors.set(p.id, p);

  // Everything above needed no D1. Only gifts that could still send are looked up, in batches.
  const sendable: { item: DonationItem; donor: PromptDonor }[] = [];
  const skip = (item: DonationItem, reason: string): void => {
    if (dryRun) console.log(`dtd-sync: prompt item ${item.id} skip ${reason}`);
  };
  for (const item of items) {
    const donor = item.donorItemId === null ? null : (donors.get(item.donorItemId) ?? null);
    const decision = promptDecision(item, donor, cfg, outreach, open, now);
    if (!decision.send) skip(item, decision.reason);
    else if (donor !== null) sendable.push({ item, donor });
  }
  const itemIds = sendable.map(({ item }) => item.id);
  const cooldownSinceISO = new Date(now.getTime() - outreach.donorCooldownDays * DAY_MS).toISOString();
  const rows = await promptRows(db, itemIds);
  const known = await itemsKnownToDtd(db, itemIds);
  const prompted = await promptedDonors(db, sendable.map(({ donor }) => donor.id), cooldownSinceISO);
  const promptedThisRun = new Set<string>();

  let sent = 0;
  let failed = 0;
  let deferred = 0;

  for (const { item, donor } of sendable) {
    const row = rows.get(item.id);
    if (row !== undefined && row.state !== 'failed') continue;
    if (row !== undefined && row.attempts >= outreach.maxAttempts) {
      console.log(`dtd-sync: prompt item ${item.id} gave up after ${row.attempts} attempts`);
      continue;
    }
    const facts: PromptFacts = {
      pairedGiftIds,
      knownToDtd: known.has(item.id),
      inCooldown: promptedThisRun.has(donor.id) || prompted.some((p) => p.donorItemId === donor.id && p.itemId !== item.id),
    };
    const decision = promptDecision(item, donor, cfg, outreach, facts, now);
    if (!decision.send) {
      skip(item, decision.reason);
      continue;
    }
    if (donor.email === null || item.date === null || item.amount === null) continue;
    const variant = decision.variant.kind;
    if (dryRun) {
      promptedThisRun.add(donor.id);
      console.log(`dtd-sync: prompt item ${item.id} would-send ${variant}`);
      continue;
    }
    if (sent >= MAX_SENDS_PER_RUN) {
      deferred++;
      continue;
    }

    try {
      const mail = renderPromptEmail({ variant: decision.variant, firstName: donor.greetingName ?? '', amount: item.amount, giftDate: item.date }, outreach);
      const claim = {
        itemId: item.id, donorItemId: donor.id, variant, giftDate: item.date, nowISO, maxAttempts: outreach.maxAttempts, cooldownSinceISO,
      };
      if (!(await claimPrompt(db, claim))) continue; // another run has this gift, or emailed this donor
      promptedThisRun.add(donor.id);
      try {
        await email.send({
          to: donor.email.trim(),
          from: { email: outreach.fromAddress, name: outreach.fromName },
          replyTo: outreach.replyTo,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
      } catch (err) {
        failed++;
        if (await handleSendFailure(db, item.id, err)) break;
        promptedThisRun.delete(donor.id); // certainly not sent: the donor's other gift may be
        continue;
      }
      await markPromptSent(db, item.id, nowISO);
      sent++;
    } catch (err) {
      logItemFailure('prompt', item.id, err);
      continue;
    }
    try {
      await monday.updateDonation(item.id, promptValues(item, now, config, outreach));
      await markPromptWritten(db, item.id, nowISO);
    } catch (err) {
      logItemFailure('prompt write', item.id, err); // emailed; the next run repairs the columns
    }
  }

  console.log(JSON.stringify({ job: 'prompt', dryRun, considered: items.length, sent, failed, repaired, deferred }));
  return { considered: items.length, sent, failed, repaired };
}
