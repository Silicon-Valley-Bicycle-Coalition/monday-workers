import { Hono, type Context } from 'hono';
import { APPS, type AppKey } from './apps';
import type { Env } from './env';
import { runProbe } from './probe';
import { authorizeUrl, exchangeCode, fetchMe, pkcePair, revoke, type FetchFn } from './mondayOAuth';
import type { D1AppTokenStore } from './tokenStore';

export interface RouteDeps {
  store: D1AppTokenStore;
  env: Env;
  fetchFn: FetchFn;
  now: () => Date;
  // Hands out the app's current access token; required only by the probe route.
  broker?: { token(app: AppKey): Promise<string> };
}

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, lines: string[]): string {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><h1>${esc(title)}</h1>${lines
    .map((l) => `<p>${l}</p>`)
    .join('')}`;
}

// START_KEY travels in a POST body, never the URL: request URLs land in Workers Logs and browser history.
function keyForm(title: string, extraFields = ''): string {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><h1>${esc(title)}</h1>` +
    `<form method="post"><p><label>START_KEY <input type="password" name="key" autocomplete="off" required></label></p>` +
    `${extraFields}<p><button type="submit">Continue</button></p></form>`;
}

async function formField(c: Context, name: string): Promise<string> {
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

function isAppKey(name: string): name is AppKey {
  return Object.prototype.hasOwnProperty.call(APPS, name);
}

// Compares SHA-256 digests with a branch-free byte loop, so neither content nor length leaks.
async function keyMatches(supplied: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false; // unset or empty START_KEY locks the route
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function credentials(env: Env, app: AppKey): { clientId: string; clientSecret: string } | { missing: string } {
  const vars = env as unknown as Record<string, string | undefined>;
  const { clientIdVar, clientSecretVar } = APPS[app];
  const clientId = vars[clientIdVar];
  if (!clientId) return { missing: clientIdVar };
  const clientSecret = vars[clientSecretVar];
  if (!clientSecret) return { missing: clientSecretVar };
  return { clientId, clientSecret };
}

// No response, page or log line below ever includes an access or refresh token.
export function createApp(deps: RouteDeps): Hono {
  const { store, env, fetchFn, now, broker } = deps;
  const app = new Hono();

  // Status only: no token, no error text, and whether alerts can be sent (never the webhook URL).
  app.get('/health', async (c) => {
    type AppHealth = {
      app: AppKey;
      status: 'ok' | 'needs_consent' | 'missing';
      expiresAt?: string;
      lastRefreshErrorAt?: string;
    };
    const apps: AppHealth[] = [];
    for (const key of Object.keys(APPS) as AppKey[]) {
      const row = await store.get(key);
      if (row === null) apps.push({ app: key, status: 'missing' });
      else if (row.status === 'needs_consent') apps.push({ app: key, status: 'needs_consent' });
      else {
        const entry: AppHealth = { app: key, status: 'ok', expiresAt: row.accessTokenExpiresAt };
        if (row.lastRefreshErrorAt !== null) entry.lastRefreshErrorAt = row.lastRefreshErrorAt;
        apps.push(entry);
      }
    }
    return c.json({ alerts: env.SLACK_WEBHOOK_URL ? 'configured' : 'unconfigured', apps });
  });

  // GET only shows the key form; nothing is checked or stored until it's posted.
  app.get('/oauth/start/:app', (c) => {
    const name = c.req.param('app');
    if (!isAppKey(name)) return c.text('unknown app', 404);
    return c.html(keyForm(`Authorize the ${name} app`));
  });

  // The key gates the POST, including the unknown-app 404.
  app.post('/oauth/start/:app', async (c) => {
    if (!(await keyMatches(await formField(c, 'key'), env.START_KEY))) return c.text('forbidden', 403);
    const name = c.req.param('app');
    if (!isAppKey(name)) return c.text('unknown app', 404);
    const creds = credentials(env, name);
    if ('missing' in creds) return c.text(`${creds.missing} is not set`, 500);

    const state = crypto.randomUUID();
    const { verifier, challenge } = await pkcePair();
    const redirectUri = new URL('/oauth/callback', c.req.url).href;
    await store.putPending(state, name, verifier, redirectUri, now());
    return c.redirect(
      authorizeUrl({
        clientId: creds.clientId,
        redirectUri,
        scopes: APPS[name].scopes,
        state,
        codeChallenge: challenge,
        subdomain: env.MONDAY_SUBDOMAIN,
      }),
      303
    );
  });

  // Verification aid for the Monday checks (token scope, header form, platform_api, complexity).
  // Off unless PROBE_ENABLED is exactly "true" (404 before the key check). Same key gate as /oauth/start; the response never includes the token.
  app.get('/oauth/probe/:app', (c) => {
    if (env.PROBE_ENABLED !== 'true') return c.text('not found', 404);
    const name = c.req.param('app');
    if (!isAppKey(name)) return c.text('unknown app', 404);
    return c.html(keyForm(`Probe the ${name} app`, `<p><label>Workspace id <input name="workspace" inputmode="numeric" required></label></p>`));
  });

  app.post('/oauth/probe/:app', async (c) => {
    if (env.PROBE_ENABLED !== 'true') return c.text('not found', 404);
    if (!(await keyMatches(await formField(c, 'key'), env.START_KEY))) return c.text('forbidden', 403);
    const name = c.req.param('app');
    if (!isAppKey(name)) return c.text('unknown app', 404);
    const workspace = await formField(c, 'workspace');
    if (!/^\d+$/.test(workspace)) return c.text('workspace must be a numeric workspace id', 400);
    if (!broker) return c.text('probe is not configured', 500);
    let token: string;
    try {
      token = await broker.token(name);
    } catch (err) {
      console.error(`monday-auth: probe could not get a ${name} token: ${err instanceof Error ? err.message : 'error'}`);
      const needsConsent = err instanceof Error && /needs consent|not authorized yet/i.test(err.message);
      return c.text(
        needsConsent
          ? `the ${name} app needs consent; run its consent flow`
          : `could not get a ${name} token right now; try again`,
        409
      );
    }
    return c.json(await runProbe(name, token, workspace, fetchFn));
  });

  app.get('/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return c.html(page('Consent failed', ['Missing code or state.']), 400);
    const pending = await store.takePending(state, now());
    if (pending === null) {
      return c.html(page('Consent failed', ['Unknown or expired state. Start the consent flow again.']), 400);
    }
    const key = pending.app;
    const creds = credentials(env, key);
    if ('missing' in creds) return c.html(page('Misconfigured', [`${esc(creds.missing)} is not set.`]), 500);

    let tokens;
    try {
      tokens = await exchangeCode(
        { ...creds, code, redirectUri: pending.redirectUri, verifier: pending.codeVerifier },
        fetchFn,
        now
      );
    } catch (err) {
      console.error(`monday-auth: code exchange for the ${key} app failed: ${err instanceof Error ? err.message : 'error'}`);
      return c.html(page('Consent failed', ['Monday did not accept the authorization code. Start the flow again.']), 502);
    }

    // Revokes both new tokens; a failure of either is logged (never with the token) and ignored.
    // Returns true only if both revokes succeeded.
    const revokeQuietly = async (): Promise<boolean> => {
      const results = await Promise.all(
        (
          [
            [tokens.accessToken, 'access_token'],
            [tokens.refreshToken, 'refresh_token'],
          ] as const
        ).map(async ([token, tokenTypeHint]) => {
          try {
            await revoke({ ...creds, token, tokenTypeHint }, fetchFn);
            return true;
          } catch (err) {
            console.error(`monday-auth: revoke after a failed consent failed: ${err instanceof Error ? err.message : 'error'}`);
            return false;
          }
        })
      );
      return results.every(Boolean);
    };

    let me;
    try {
      me = await fetchMe(tokens.accessToken, fetchFn);
    } catch (err) {
      console.error(`monday-auth: could not identify the consenting user: ${err instanceof Error ? err.message : 'error'}`);
      await revokeQuietly();
      return c.html(page('Consent failed', ['Could not identify the Monday user; nothing was stored. Start the flow again.']), 502);
    }

    if (!env.EXPECTED_USER_ID || me.id !== env.EXPECTED_USER_ID) {
      const revoked = await revokeQuietly();
      return c.html(
        page('Wrong Monday user', [
          `Consent was given as Monday user ${esc(me.id)} (${esc(me.name)}), but this Worker only accepts user ${esc(env.EXPECTED_USER_ID || '(none configured)')}.`,
          'Nothing was stored.',
          revoked
            ? 'The tokens were revoked.'
            : 'Revoking a token failed; remove the app from that user in Monday if it is still listed.',
          'Log in to Monday as the integration user and start the consent flow again.',
        ]),
        403
      );
    }

    try {
      await store.save({
        app: key,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.expiresAt,
        authorizedUserId: me.id,
      });
    } catch {
      // The error text is not logged: a driver error could echo the bound token values.
      console.error(`monday-auth: saving the ${key} token failed`);
      await revokeQuietly();
      return c.html(
        page('Token not stored', [
          'Monday accepted the consent, but the token could not be stored, so it was revoked.',
          'Run the consent flow again.',
        ]),
        500
      );
    }
    return c.html(
      page('Authorized', [
        `App: ${esc(key)}`,
        `Monday user: ${esc(me.name)} (id ${esc(me.id)})`,
        `Scopes: ${esc(APPS[key].scopes.join(', '))}`,
        `Access token expires: ${esc(tokens.expiresAt)}`,
        'You can close this page.',
      ])
    );
  });

  return app;
}
