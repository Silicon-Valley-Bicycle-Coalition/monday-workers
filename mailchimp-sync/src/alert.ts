// Slack alert for dead-lettered syncs (#37) — copied from monday-backup's src/alert.ts (same
// SLACK_WEBHOOK_URL secret name and { text } incoming-webhook payload) rather than shared, per the
// repo's no-shared-package convention. Optional: with the secret unset the caller's console.error
// is the only signal (log only). Never throws — callers have already acked by the time it runs.
// The webhook URL is itself a credential, so it is never logged.
export async function sendAlert(webhookUrl: string | undefined, text: string): Promise<void> {
  if (!webhookUrl) return;
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      // Bounded so a hung webhook can't hold the DLQ consumer invocation open.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`mailchimp-sync: Slack alert POST failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.error(`mailchimp-sync: Slack alert POST threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
