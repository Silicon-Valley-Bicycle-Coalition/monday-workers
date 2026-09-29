export async function sendFailureAlert(
  webhookUrl: string,
  sourceId: string,
  sourceName: string,
  consecutiveFailures: number,
  lastError: string
): Promise<void> {
  if (!webhookUrl) {
    console.error('svbc-calendars: Slack alert skipped, SLACK_WEBHOOK_URL is not configured');
    return;
  }
  // The streak counts fetch attempts, not days: the daily cron and every .ics cache MISS each make
  // one attempt (see calendarSource.ts), so 3 failures can happen within minutes.
  const text = `svbc-calendars: source "${sourceName}" (${sourceId}) has failed ${consecutiveFailures} consecutive fetch attempts. Last error: ${lastError}`;
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      // Bounded like monday-backup's and mailchimp-sync's alerts: this is awaited on the .ics
      // cache-MISS path (calendarSource.ts), so a hung Slack webhook would otherwise hold a
      // subscriber's calendar fetch open indefinitely.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`svbc-calendars: Slack alert POST failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.error(`svbc-calendars: Slack alert POST threw: ${err}`);
  }
}
