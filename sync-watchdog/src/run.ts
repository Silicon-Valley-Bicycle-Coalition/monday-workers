import { postToSlack } from './alert';
import { cronSubjects, queueSubjects, writeSwitchSubjects, type SubjectResult } from './checks';
import type { CloudflareApi } from './cloudflare';
import type { WatchdogConfig } from './config';
import { decide, markSent, type SubjectState } from './state';

export interface RunDeps {
  cfg: WatchdogConfig;
  api: CloudflareApi;
  flags: KVNamespace;
  state: KVNamespace;
  slackWebhookUrl: string;
  now: Date;
  environment: 'production' | 'sandbox';
}

const key = (subject: string) => `subject:${subject}`;

async function loadState(kv: KVNamespace, subject: string): Promise<SubjectState | null> {
  const raw = await kv.get(key(subject));
  return raw === null ? null : (JSON.parse(raw) as SubjectState);
}

// The heartbeat goes out on the 16:xx UTC run every Monday: if it stops arriving, the watchdog is down.
const isHeartbeatRun = (now: Date) => now.getUTCDay() === 1 && now.getUTCHours() === 16;

export async function runWatchdog(deps: RunDeps): Promise<void> {
  const { cfg, api, flags, state, now } = deps;
  // Sandbox never posts to the staff channel; it logs what it would have said.
  const send =
    deps.environment === 'production'
      ? (text: string) => postToSlack(deps.slackWebhookUrl, text)
      : async (text: string) => {
          console.log(`sync-watchdog (sandbox, not sent): ${text}`);
          return false;
        };

  const cronStates = new Map<string, SubjectState>();
  for (const [worker, w] of Object.entries(cfg.watched)) {
    for (const { cron } of w.crons) {
      const subject = `cron:${worker}:${cron}`;
      const s = await loadState(state, subject);
      if (s) cronStates.set(subject, s);
    }
  }

  const results: SubjectResult[] = [
    ...(await cronSubjects(cfg, api, cronStates, now)),
    ...(await writeSwitchSubjects(cfg, flags)),
    ...(await queueSubjects(cfg, api)),
  ];

  const failed = results.filter((r) => r.health === 'check-failed');
  if (failed.length > 0) {
    console.error(`sync-watchdog: ${failed.length} check(s) failed: ${failed.map((r) => `${r.subject} (${r.error})`).join('; ')}`);
  }

  for (const r of results) {
    if (r.health === 'check-failed') continue; // state left as it was
    const prev = r.subject.startsWith('cron:') ? (cronStates.get(r.subject) ?? null) : await loadState(state, r.subject);
    let { post, next } = decide(r.subject, r.health, prev, now);
    if (post && (await send(post.text)) && post.kind !== 'recovered') next = markSent(next, now);
    await state.put(key(r.subject), JSON.stringify(next));
  }

  if (isHeartbeatRun(now)) {
    const healthy = results.filter((r) => r.health !== 'check-failed' && r.health.ok).length;
    await send(`sync-watchdog: running, ${healthy} of ${results.length} subjects healthy`);
  }
}
