import { Hono } from 'hono';
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

  app.get('/health', async (c) => {
    const out: { app: AppKey; status: 'ok' | 'needs_consent' | 'missing'; expiresAt?: string }[] = [];
    for (const key of Object.keys(APPS) as AppKey[]) {
      const row = await store.get(key);
      if (row === null) out.push({ app: key, status: 'missing' });
      else if (row.status === 'needs_consent') out.push({ app: key, status: 'needs_consent' });
      else out.push({ app: key, status: 'ok', expiresAt: row.accessTokenExpiresAt });
    }
    return c.json(out);
  });

  // The key gates everything under /oauth/start, including the unknown-app 404.
  app.get('/oauth/start/:app', async (c) => {
    if (!(await keyMatches(c.req.query('key') ?? '', env.START_KEY))) return c.text('forbidden', 403);
    const name = c.req.param('app');
    if (!isAppKey(name)) return c.text('unknown app', 404);
    const creds = credentials(env, name);
    if ('missing' in creds) return c.text(`${creds.missing} is not set`, 500);

    const state = crypto.randomUUID();
    const { verifier, challenge } = await pkcePair();
    await store.putPending(state, name, verifier, now());
    return c.redirect(
      authorizeUrl({
        clientId: creds.clientId,
        redirectUri: new URL('/oauth/callback', c.req.url).href,
        scopes: APPS[name].scopes,
        state,
        codeChallenge: challenge,
        subdomain: env.MONDAY_SUBDOMAIN,
      }),
      302
    );
  });

  // Verification aid for the Monday checks (token scope, header form, platform_api, complexity).
  // Same key gate as /oauth/start; the response never includes the token.
  app.get('/oauth/probe/:app', async (c) => {
    if (!(await keyMatches(c.req.query('key') ?? '', env.START_KEY))) return c.text('forbidden', 403);
    const name = c.req.param('app');
    if (!isAppKey(name)) return c.text('unknown app', 404);
    const workspace = c.req.query('workspace') ?? '';
    if (!/^\d+$/.test(workspace)) return c.text('workspace must be a numeric workspace id', 400);
    if (!broker) return c.text('probe is not configured', 500);
    let token: string;
    try {
      token = await broker.token(name);
    } catch (err) {
      console.error(`monday-auth: probe could not get a ${name} token: ${err instanceof Error ? err.message : 'error'}`);
      return c.text(`no usable token for the ${name} app; run the consent flow`, 409);
    }
    return c.json(await runProbe(token, workspace, fetchFn));
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
        { ...creds, code, redirectUri: new URL('/oauth/callback', c.req.url).href, verifier: pending.codeVerifier },
        fetchFn,
        now
      );
    } catch (err) {
      console.error(`monday-auth: code exchange for the ${key} app failed: ${err instanceof Error ? err.message : 'error'}`);
      return c.html(page('Consent failed', ['Monday did not accept the authorization code. Start the flow again.']), 502);
    }

    const revokeQuietly = async () => {
      try {
        await revoke({ ...creds, token: tokens.accessToken }, fetchFn);
        return true;
      } catch (err) {
        console.error(`monday-auth: revoke after a rejected consent failed: ${err instanceof Error ? err.message : 'error'}`);
        return false;
      }
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
            ? 'The token was revoked.'
            : 'Revoking the token failed; remove the app from that user in Monday if it is still listed.',
          'Log in to Monday as the integration user and start the consent flow again.',
        ]),
        403
      );
    }

    await store.save({
      app: key,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.expiresAt,
      authorizedUserId: me.id,
    });
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
