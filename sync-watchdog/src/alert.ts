// Posts one line to the staff Slack channel. Same shape as monday-backup/src/alert.ts, but returns
// whether Slack accepted it, so src/run.ts only marks an alert sent once it really went out.
export async function postToSlack(webhookUrl: string, text: string): Promise<boolean> {
  if (!webhookUrl) {
    console.error('sync-watchdog: Slack alert skipped, SLACK_WEBHOOK_URL is not configured');
    return false;
  }
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.error(`sync-watchdog: Slack alert POST failed: ${response.status} ${response.statusText}`);
    return response.ok;
  } catch (err) {
    console.error(`sync-watchdog: Slack alert POST threw: ${err}`);
    return false;
  }
}
