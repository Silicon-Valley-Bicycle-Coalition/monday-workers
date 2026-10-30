// Slack incoming-webhook alerter (pattern from monday-backup/src/alert.ts). A no-op when no
// webhook is configured; never throws, so an alert failure can't mask the error being reported.
export function slackAlert(webhookUrl: string | undefined, fetchFn: typeof fetch): (text: string) => Promise<void> {
  return async (text: string) => {
    if (!webhookUrl) {
      console.error('monday-auth: Slack alert skipped, SLACK_WEBHOOK_URL is not configured');
      return;
    }
    try {
      const response = await fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `monday-auth: ${text}` }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) console.error(`monday-auth: Slack alert POST failed: HTTP ${response.status}`);
    } catch (err) {
      console.error(`monday-auth: Slack alert POST threw: ${err instanceof Error ? err.name : 'error'}`);
    }
  };
}
