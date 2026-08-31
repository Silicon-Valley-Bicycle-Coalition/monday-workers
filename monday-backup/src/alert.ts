export async function sendFailureAlert(webhookUrl: string, summary: string, detail: string): Promise<void> {
  if (!webhookUrl) {
    console.error('monday-backup: Slack alert skipped, SLACK_WEBHOOK_URL is not configured');
    return;
  }
  const text = `monday-backup: ${summary}. ${detail}`;
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      console.error(`monday-backup: Slack alert POST failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.error(`monday-backup: Slack alert POST threw: ${err}`);
  }
}
