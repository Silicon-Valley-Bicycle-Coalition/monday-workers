import type { LetterSendStore } from '../db/letterSends';
import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/types';
import type { Config, LetterSendQueueMessage } from '../types';
import { loadLetterData } from './loadLetterData';
import { lettersEnabled, letterCronConfigured } from '../config';
import { localeFromMondayLabel, DEFAULT_LOCALE, type Locale } from '../i18n/locales';
import { generateToken } from '../crypto/token';
import { sha256Hex } from '../crypto/hash';
import { retryDelaySeconds, type QueueMessageLike } from '../queueRetry';
import { errorText } from '../logSafe';
import { logDebug, messageDisposition } from '../flags';
import { dryRunLetterDeps, type BatchSkipContext } from '../writeSwitch';

export interface ProcessLetterSendBatchDeps {
  store: LetterSendStore;
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  emailSender: EmailSender;
  config: Config;
  now: () => Date;
}

// The queue entry point (index.ts), gated like consumeChangeQueueBatch. A dry run drops every
// letter_sends write, so the row stays 'queued': the cron never picks it up again (it skips any
// donor with a row), and only a staff button click — triggerLetterSend's stranded-row re-send —
// gives it another attempt.
export async function consumeLetterSendBatch(
  messages: QueueMessageLike<LetterSendQueueMessage>[],
  deps: ProcessLetterSendBatchDeps,
  gate: BatchSkipContext
): Promise<void> {
  // Loaded on the first message that runs, so a held batch makes no Monday read.
  let templates: LetterBodyTemplates | undefined;
  for (const message of messages) {
    const disposition = messageDisposition(gate.mode, message.body);
    if (disposition === 'retry') {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    templates ??= await loadBodyTemplates(deps);
    if (disposition === 'write') {
      await handleMessage(message, deps, templates);
    } else {
      const ctx = { ...gate, deliveryId: `letter-send:${message.body.sendId}` };
      logDebug(ctx, 'message', message.body);
      await handleMessage(message, dryRunLetterDeps(deps, ctx), templates);
    }
  }
}

// Every message live — the `write` path above, and the tests that predate the switch.
export async function processLetterSendBatch(
  messages: QueueMessageLike<LetterSendQueueMessage>[],
  deps: ProcessLetterSendBatchDeps
): Promise<void> {
  const templates = await loadBodyTemplates(deps);
  for (const message of messages) await handleMessage(message, deps, templates);
}

async function handleMessage(
  message: QueueMessageLike<LetterSendQueueMessage>,
  deps: ProcessLetterSendBatchDeps,
  templates: LetterBodyTemplates
): Promise<void> {
  try {
    await processOne(message.body.sendId, deps, templates);
    message.ack();
  } catch (err) {
    console.error(`member-portal consumer: failed to process letter send ${message.body.sendId}: ${errorText(err)}`);
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  }
}

interface LetterBodyTemplates {
  default?: string;
  byLocale: Partial<Record<Locale, string>>;
}

// The staff-edited email bodies live on the Letter Settings board (letterCron config): a
// default template plus optional per-locale columns. Fetched once per batch, not per message.
// An unreachable board falls back to the localized built-in copy rather than blocking sends —
// templates are presentation, not correctness, so a Monday hiccup shouldn't park a batch in
// the retry loop.
async function loadBodyTemplates(deps: ProcessLetterSendBatchDeps): Promise<LetterBodyTemplates> {
  const lc = deps.config.letterCron;
  if (!letterCronConfigured(deps.config) || lc.boardId === null) return { byLocale: {} };
  try {
    const settings = await deps.monday.getLetterSettings({
      boardId: lc.boardId,
      columns: lc.columns,
      settingsItemName: lc.settingsItemName,
    });
    const template = settings?.bodyTemplate.trim();
    return {
      default: template ? template : undefined,
      byLocale: settings?.bodyTemplatesByLocale ?? {},
    };
  } catch (err) {
    console.error(
      `member-portal consumer: failed to read the Letter Settings board — using the built-in email copy: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return { byLocale: {} };
  }
}

async function processOne(sendId: number, deps: ProcessLetterSendBatchDeps, templates: LetterBodyTemplates): Promise<void> {
  const row = await deps.store.getById(sendId);
  if (row === null) {
    // A queued message with no row is a bug worth surfacing — let retries exhaust into the DLQ
    // rather than acking it into silence.
    throw new Error(`no letter_sends row for id ${sendId}`);
  }
  if (row.status === 'sending') {
    // An earlier delivery claimed this row and then either sent the email but failed to record
    // it, or died between claim and send. We can't tell which, and a duplicate tax-letter email
    // is the failure issue #31 set out to remove — so never resend automatically. The letter
    // itself is always in the portal; the email is only a notification.
    console.warn(`member-portal consumer: letter send ${row.id} was already claimed by an earlier attempt — not re-sending`);
    return;
  }
  if (row.status !== 'queued') {
    return; // redelivery after a crash between send/skip and ack — nothing to do
  }

  if (!lettersEnabled(deps.config)) {
    // taxLetter isn't signed off yet — a standing config gate, not a transient failure, so this
    // is a deliberate skip, not a retry candidate. Re-clicking the button after signoff requeues
    // this same row (triggerLetterSend's dedupe-hit handling for a 'skipped' row) rather than
    // creating a fresh one — the letter_sends UNIQUE(donor_item_id, year) index means a fresh row
    // can never be created for this donor+year anyway.
    await deps.store.markSkipped(row.id, deps.now().toISOString());
    return;
  }

  const letterData = await loadLetterData(row.donorItemId, row.year, deps.monday, deps.config.taxLetter, deps.now());
  if (letterData === null) {
    // The donor's gifts for this year were removed/corrected between the webhook firing and this
    // consumer running — nothing to send.
    await deps.store.markSkipped(row.id, deps.now().toISOString());
    return;
  }

  const contact = await deps.monday.getDonorContactInfo(row.donorItemId);
  if (contact.email.trim().length === 0) {
    // No email on file in Monday — sending to '' would fail every attempt, burning the full
    // retry budget into the DLQ while the row stays 'queued' and gets re-enqueued on every
    // subsequent button click (see triggerLetterSend's requeue-on-'skipped' handling). Not a
    // transient failure, so skip rather than retry.
    console.error(`member-portal consumer: no email on file for donor "${row.donorItemId}" — skipping letter send`);
    await deps.store.markSkipped(row.id, deps.now().toISOString());
    return;
  }

  // Mint the login token first, before claiming the row: a D1 failure here must leave the row
  // 'queued' so the retry can try again. (Minted after the claim, it stranded the row in
  // 'sending' with no email ever sent.) If a later step fails, this token is simply never used
  // and expires — harmless.
  const rawToken = generateToken();
  const tokenHash = await sha256Hex(rawToken);
  // letterLinkTtlHours, not magicLinkTtlMinutes: this email is read whenever the donor gets to
  // it, not while they wait on a login form (issue #31). Still single-use — consumeToken claims it.
  const expiresAt = new Date(deps.now().getTime() + deps.config.auth.letterLinkTtlHours * 3_600_000).toISOString();
  await deps.tokenStore.createToken({ tokenHash, donorItemIds: [row.donorItemId], expiresAt });

  // Same Monday-preference resolution as requestLogin: the Preferred Language label maps to a
  // locale, anything unset/unrecognized falls back to English. The lang param makes the portal
  // render in the donor's language when the magic link lands.
  const locale: Locale = localeFromMondayLabel(contact.preferredLanguage) ?? DEFAULT_LOCALE;
  const template = templates.byLocale[locale]?.trim();
  const loginUrl = `${deps.config.auth.portalBaseUrl}/auth/callback?token=${rawToken}&lang=${locale}`;

  // At-most-once: claim the row (queued → sending) immediately before the send, which is the only
  // step inside the claim window. The email and the D1 status write are two systems with no
  // shared transaction; previously a markSent failure after a successful send left the row
  // 'queued' and the retry emailed the donor again. Now a redelivery sees 'sending' and stops.
  // Every failure we can observe returns the row to 'queued' (send error → releaseClaim) or is
  // harmless ('sending' after a real send). The one residual gap: the Worker dying between this
  // claim and the send completing, or releaseClaim itself failing — the row then stays 'sending'
  // and needs the manual requeue documented in the README, rather than risking a duplicate.
  if (!(await deps.store.claimForSending(row.id, deps.now().toISOString()))) {
    return; // a concurrent delivery won the claim
  }

  try {
    await deps.emailSender.sendLetterReadyEmail({
      to: contact.email,
      donorName: contact.name,
      year: row.year,
      loginUrl,
      locale,
      bodyTemplate: template ? template : templates.default,
    });
  } catch (sendErr) {
    // The send itself failed, so nothing went out — hand the row back for the retry. A failure
    // to release is logged but must not mask the send error, which is what the retry is for.
    try {
      await deps.store.releaseClaim(row.id);
    } catch (releaseErr) {
      console.error(
        `member-portal consumer: letter send ${row.id} failed and its claim could not be released (row stays 'sending' — requeue by hand): ${
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
        }`
      );
    }
    throw sendErr;
  }

  try {
    await deps.store.markSent(row.id, deps.now().toISOString());
  } catch (err) {
    // The email is out; the row stays 'sending', which already blocks any resend. Retrying would
    // accomplish nothing, so log and let the message ack.
    console.error(
      `member-portal consumer: letter send ${row.id} was emailed but not marked sent (row stays 'sending'): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
