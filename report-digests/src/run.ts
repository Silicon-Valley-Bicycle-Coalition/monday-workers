import { DIGEST_KEYS, type DigestKey, type DigestsConfig } from './config';
import { buildDigest } from './digests';
import type { DigestsMondayClient } from './monday/client';
import { renderDigest } from './render';
import { isDue, type LocalTime } from './schedule';

export interface RunDeps {
  monday: DigestsMondayClient;
  email: SendEmail;
  config: DigestsConfig;
}

export type RunResult =
  | { key: DigestKey; sent: true; count: number; recipients: number }
  | { key: DigestKey; sent: false; reason: string };

export function dueDigests(config: DigestsConfig, now: LocalTime): DigestKey[] {
  return DIGEST_KEYS.filter((key) => {
    const cfg = config.digests[key];
    return cfg !== undefined && isDue(cfg.schedule, now);
  });
}

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

// Builds one digest and emails it. `force` sends even an empty skipWhenEmpty digest (the operator
// route, for checking a digest by hand).
export async function runDigest(deps: RunDeps, key: DigestKey, now: LocalTime, { force = false } = {}): Promise<RunResult> {
  const cfg = deps.config.digests[key];
  if (cfg === undefined) throw new Error(`digest ${key}: not configured in this environment`);
  const digest = await buildDigest(key, deps.monday, deps.config, now);
  if (digest.count === 0 && cfg.skipWhenEmpty && !force) return { key, sent: false, reason: 'empty' };

  const users = (await deps.monday.getUsers(cfg.recipients)).filter((u) => u.enabled && u.email);
  // Fail closed on the domain (GL#70): a Monday user whose address is outside recipientDomains (a
  // guest, a personal address) never gets the digest. Unlike a departure, that's a misconfiguration,
  // so it's an error for Workers Issues. Both are logged by id, never by address, and the rest still
  // get the email; nobody left at all is an error.
  const offDomain = users.filter((u) => !deps.config.recipientDomains.includes(domainOf(u.email)));
  if (offDomain.length > 0) console.error(`digest ${key}: recipient user id(s) ${offDomain.map((u) => u.id).join(', ')} have an address outside recipientDomains; not sent to them`);
  const to = users.filter((u) => !offDomain.includes(u)).map((u) => u.email);
  const missing = cfg.recipients.filter((id) => !users.some((u) => Number(u.id) === id));
  if (missing.length > 0) console.warn(`digest ${key}: recipient user id(s) ${missing.join(', ')} not found or deactivated`);
  if (to.length === 0) throw new Error(`digest ${key}: no active recipients`);

  const email = renderDigest(digest, deps.config.logoUrl);
  await deps.email.send({
    to,
    from: { email: deps.config.fromAddress, name: deps.config.fromName },
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  return { key, sent: true, count: digest.count, recipients: to.length };
}
