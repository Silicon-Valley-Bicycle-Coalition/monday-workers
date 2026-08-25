import type { LetterSendStore } from '../db/letterSends';
import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/resend';
import type { Config, LetterSendQueueMessage } from '../types';
import { loadLetterData } from './loadLetterData';
import { lettersEnabled } from '../config';
import { generateToken } from '../crypto/token';
import { sha256Hex } from '../crypto/hash';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface ProcessLetterSendBatchDeps {
  store: LetterSendStore;
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  emailSender: EmailSender;
  config: Config;
  now: () => Date;
}

export async function processLetterSendBatch(
  messages: QueueMessageLike<LetterSendQueueMessage>[],
  deps: ProcessLetterSendBatchDeps
): Promise<void> {
  for (const message of messages) {
    try {
      await processOne(message.body.sendId, deps);
      message.ack();
    } catch (err) {
      console.error(
        `donor-portal consumer: failed to process letter send ${message.body.sendId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      message.retry();
    }
  }
}

async function processOne(sendId: number, deps: ProcessLetterSendBatchDeps): Promise<void> {
  const row = await deps.store.getById(sendId);
  if (row === null) {
    // A queued message with no row is a bug worth surfacing — let retries exhaust into the DLQ
    // rather than acking it into silence.
    throw new Error(`no letter_sends row for id ${sendId}`);
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
    console.error(`donor-portal consumer: no email on file for donor "${row.donorItemId}" — skipping letter send`);
    await deps.store.markSkipped(row.id, deps.now().toISOString());
    return;
  }

  const rawToken = generateToken();
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = new Date(deps.now().getTime() + deps.config.auth.magicLinkTtlMinutes * 60_000).toISOString();
  await deps.tokenStore.createToken({ tokenHash, donorItemIds: [row.donorItemId], expiresAt });

  const loginUrl = `${deps.config.auth.portalBaseUrl}/auth/callback?token=${rawToken}`;
  await deps.emailSender.sendLetterReadyEmail({
    to: contact.email,
    donorName: contact.name,
    year: row.year,
    loginUrl,
  });

  await deps.store.markSent(row.id, deps.now().toISOString());
}
