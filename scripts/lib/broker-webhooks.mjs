// Monday webhook subscriptions for the setup scripts, made either through the monday-auth broker's
// /oauth/webhooks/:app route (GL#110: the app owns the webhook, so Monday signs its deliveries with
// the app's Signing Secret) or, as before, with a personal MONDAY_API_TOKEN (unsigned deliveries).
// Both return the same three calls: list(board), create({ board, url, event, config }), remove(id).

const LIMITED_WAIT_MS = 61_000; // the broker allows 10 POST /oauth/* a minute per IP
const LIMITED_TRIES = 6;

// Through the broker. A 429 is the broker's own limiter refusing before the route runs, so even a
// create is safe to send again. Any other failure throws; the broker has already scrubbed the
// token and the webhook URL from its error text.
export function brokerWebhooks({ brokerUrl, key, app = 'sync', fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const endpoint = `${brokerUrl.replace(/\/$/, '')}/oauth/webhooks/${app}`;
  async function call(fields) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetchFn(endpoint, { method: 'POST', body: new URLSearchParams({ key, ...fields }) });
      if (res.status === 429 && attempt < LIMITED_TRIES) {
        log(`broker rate limit; waiting ${LIMITED_WAIT_MS / 1000}s`);
        await sleep(LIMITED_WAIT_MS);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`broker ${fields.op} failed: HTTP ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text);
    }
  }
  return {
    async list(board) {
      return (await call({ op: 'list', board: String(board) })).webhooks ?? [];
    },
    async create({ board, url, event, config }) {
      const fields = { op: 'create', board: String(board), url, event };
      if (config !== undefined && config !== null) fields.config = typeof config === 'string' ? config : JSON.stringify(config);
      return (await call(fields)).create_webhook;
    },
    async remove(id) {
      return (await call({ op: 'delete', id: String(id) })).delete_webhook;
    },
  };
}

// With a token, through the caller's `graphql(query, variables)` (the Worker's MondayGraphQL copy).
export function tokenWebhooks(graphql) {
  return {
    async list(board) {
      return (await graphql('query ($board: ID!) { webhooks(board_id: $board) { id event board_id config } }', { board: String(board) })).webhooks ?? [];
    },
    async create({ board, url, event, config }) {
      const data = await graphql(
        `mutation ($board: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
          create_webhook(board_id: $board, url: $url, event: $event, config: $config) { id board_id event config } }`,
        { board: String(board), url, event, config: config === undefined || config === null ? null : typeof config === 'string' ? config : JSON.stringify(config) },
      );
      return data.create_webhook;
    },
    async remove(id) {
      return (await graphql('mutation ($id: ID!) { delete_webhook(id: $id) { id board_id } }', { id: String(id) })).delete_webhook;
    },
  };
}

// MONDAY_AUTH_URL (the broker's base URL) plus START_KEY selects the broker; otherwise a
// `graphql` function (built from MONDAY_API_TOKEN) is required. Returns { webhooks, via } or
// { error } naming what's missing.
export function webhooksFromEnv(env, graphql, opts = {}) {
  if (env.MONDAY_AUTH_URL) {
    if (!env.START_KEY) return { error: 'MONDAY_AUTH_URL is set, so START_KEY is required' };
    return { webhooks: brokerWebhooks({ brokerUrl: env.MONDAY_AUTH_URL, key: env.START_KEY, ...opts }), via: 'broker' };
  }
  if (!graphql) return { error: 'set MONDAY_AUTH_URL and START_KEY (app-owned, signed webhooks) or MONDAY_API_TOKEN' };
  return { webhooks: tokenWebhooks(graphql), via: 'token' };
}
