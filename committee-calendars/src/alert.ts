export async function sendFailureAlert(
  webhookUrl: string,
  sourceId: string,
  sourceName: string,
  consecutiveFailures: number,
  lastError: string
): Promise<void> {
  if (!webhookUrl) {
    console.error('committee-calendars: Slack alert skipped, SLACK_WEBHOOK_URL is not configured');
    return;
  }
  const text = `committee-calendars: source "${sourceName}" (${sourceId}) has failed ${consecutiveFailures} days in a row. Last error: ${lastError}`;
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      console.error(`committee-calendars: Slack alert POST failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.error(`committee-calendars: Slack alert POST threw: ${err}`);
  }
}
