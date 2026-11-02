// Staff API: preview a search on the map, then confirm it to queue the matches onto a results
// board. Everything is behind Cloudflare Access; preview never writes anything.
import { Hono, type MiddlewareHandler } from 'hono';
import { renderPage } from './page';
import { requireAccess, type AccessVariables } from './access';
import type { Config } from './config';
import { readWriteMode, stampFor } from './flags';
import { OsmError, type OsmClient } from './locate/osm';
import type { NearbyMondayClient } from './monday/client';
import { checkRequestRateLimit } from './rateLimit';
import { runSearch, SearchInputError, validatePreviewRequest, type PreviewRequest, type SearchDeps } from './search';
import type { Env, WriteMessage } from './types';

export interface Deps {
  osm: OsmClient;
  monday: NearbyMondayClient;
  config: Config;
}

export const WORKER = 'nearby-search';
const SEND_BATCH = 100;
// One confirm queues at most this many writes: past it a search is too broad to be one outreach
// list, and the queue backlog (and Monday's daily budget) is better spent on narrower searches.
export const MAX_QUEUED = 9_000;
const MAX_LABEL = 60;
const EVENT_MILES = 2;

type AppEnv = { Bindings: Env; Variables: AccessVariables };

// Returns the first problem with a Nearby label, or null. Commas are the Monday dropdown/tags
// separator, so a comma would split one label into two.
function labelError(label: unknown): string | null {
  if (typeof label !== 'string') return 'label must be a string.';
  const t = label.trim();
  if (t.length < 1 || t.length > MAX_LABEL) return `label must be 1 to ${MAX_LABEL} characters.`;
  if (t.includes(',')) return 'label must not contain commas.';
  return null;
}

// The boards a search may write to: main boards in the results workspaces, minus every board the
// Worker reads from (a source board or the Events board would get result rows mixed into it).
async function resultsBoards({ monday, config }: Deps): Promise<{ id: string; name: string }[]> {
  const reserved = new Set([...config.monday.sources.map((s) => String(s.boardId)), String(config.monday.eventsBoardId)]);
  return (await monday.listBoards(config.monday.resultsWorkspaceIds)).filter((b) => !reserved.has(b.id));
}

// `access` exists only so src/index.local.ts can swap in a bypass; the deployed entry never passes it.
export function buildApp(makeDeps: (env: Env) => Deps, access: MiddlewareHandler<AppEnv> = requireAccess()): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Unauthenticated liveness probe; every other route sits behind Cloudflare Access.
  app.get('/health', (c) => c.text('ok'));

  // The search page. Behind Access like the API; ?event=<item id> prefills it from an Events row.
  app.get('/', access, async (c) => {
    const eventId = c.req.query('event');
    let html: string;
    if (!eventId) {
      html = renderPage();
    } else {
      const { monday, config } = makeDeps(c.env);
      // A failed lookup shows the same notice as an unknown event rather than a JSON 500.
      const event = await monday
        .getEventAddress(config.monday.eventsBoardId, eventId, config.monday.eventsAddressColumn)
        .catch(() => null);
      html = event
        ? renderPage({ event: { eventItemId: eventId, eventName: event.name, address: event.address, miles: EVENT_MILES } })
        : renderPage({ notice: 'Event not found or it has no address. Type an address below instead.' });
    }
    return c.html(html);
  });

  app.use('/api/*', async (c, next) => {
    const limited = await checkRequestRateLimit(c.req.raw, { limit: (key) => c.env.REQUEST_RATE_LIMITER.limit({ key }) });
    if (limited) return limited;
    await next();
  });
  app.use('/api/*', access);

  // CSRF guard. The Access cookie rides along on a cross-site request, so a POST must prove it
  // came from this page: a JSON body (a plain HTML form can't send one without a CORS preflight,
  // which this Worker never answers) and, where the browser says, a same-origin fetch.
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST') {
      const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') return c.json({ message: 'Requests must be sent as application/json.' }, 415);
      const site = c.req.header('sec-fetch-site');
      if (site !== undefined && site !== 'same-origin') return c.json({ message: 'Cross-site requests are not allowed.' }, 403);
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof OsmError) return c.json({ message: 'OpenStreetMap is unavailable; try again shortly.' }, 502);
    if (err instanceof SearchInputError) return c.json({ message: err.message }, 400);
    console.error('nearby-search request failed', err instanceof Error ? err.name : 'unknown');
    return c.json({ message: 'Internal error.' }, 500);
  });

  async function jsonBody(req: Request): Promise<unknown> {
    try {
      return await req.json();
    } catch {
      return null;
    }
  }

  app.post('/api/preview', async (c) => {
    const body = await jsonBody(c.req.raw);
    const problem = validatePreviewRequest(body);
    if (problem) return c.json({ message: problem }, 400);
    const preview = await runSearch(body as PreviewRequest, makeDeps(c.env));
    if (preview.resolved.kind === 'not-found') return c.json({ message: preview.resolved.message }, 422);
    return c.json(preview);
  });

  app.get('/api/boards', async (c) => {
    return c.json(await resultsBoards(makeDeps(c.env)));
  });

  app.post('/api/confirm', async (c) => {
    const body = await jsonBody(c.req.raw);
    const problem = validatePreviewRequest(body);
    if (problem) return c.json({ message: problem }, 400);
    const { boardId, label: rawLabel, ...rest } = body as PreviewRequest & { boardId?: unknown; label?: unknown };
    const lerr = labelError(rawLabel);
    if (lerr) return c.json({ message: lerr }, 400);
    const label = (rawLabel as string).trim();
    if (typeof boardId !== 'number' || !Number.isInteger(boardId) || boardId <= 0) {
      return c.json({ message: 'boardId must be a board id.' }, 400);
    }

    const deps: SearchDeps = makeDeps(c.env);
    const boards = await resultsBoards(deps);
    if (!boards.some((b) => b.id === String(boardId))) return c.json({ message: 'boardId is not a results board.' }, 400);

    // Re-run the search here: the client's preview is only a picture, never the list to write.
    const request = rest as PreviewRequest;
    const preview = await runSearch(request, deps);
    if (preview.resolved.kind === 'not-found') return c.json({ message: preview.resolved.message }, 422);

    const columns = await deps.monday.findResultColumns(boardId);
    const linked = columns ? await deps.monday.linkedContactIds(boardId, columns.connectColumnId) : new Set<string>();
    const written = await c.env.DB.prepare('SELECT contact_id FROM result_rows WHERE board_id = ?').bind(String(boardId)).all<{ contact_id: string }>();
    const done = new Set(written.results.map((r) => r.contact_id));

    const fresh = preview.matches.filter((m) => !linked.has(m.id) && !done.has(m.id));
    if (fresh.length > MAX_QUEUED) {
      const n = (x: number) => x.toLocaleString('en-US');
      return c.json({ message: `This search would add ${n(fresh.length)} contacts, more than the ${n(MAX_QUEUED)} one search can add. Narrow the distance and preview again.` }, 400);
    }
    const writeMode = await readWriteMode(c.env, WORKER);
    const stamp = stampFor(writeMode);
    const messages: WriteMessage[] = fresh.map((m) => ({ boardId, label, contactId: m.id, kind: m.kind, name: m.name, stamp }));
    // The audit row goes in first (queued 0) and is updated as batches are sent, so a send that
    // fails partway still records who confirmed what and how many messages actually went out.
    const inserted = await c.env.DB.prepare(
      'INSERT INTO searches (board_id, label, query, miles, matched, queued, confirmed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(String(boardId), label, request.query ?? `event:${request.eventItemId}`, request.miles, preview.matches.length, 0, c.get('staffEmail'), new Date().toISOString())
      .run();
    const searchId = inserted.meta.last_row_id;
    let queued = 0;
    try {
      for (let i = 0; i < messages.length; i += SEND_BATCH) {
        const chunk = messages.slice(i, i + SEND_BATCH);
        await c.env.WRITES.sendBatch(chunk.map((message) => ({ body: message })));
        queued += chunk.length;
      }
    } finally {
      if (queued > 0) await c.env.DB.prepare('UPDATE searches SET queued = ? WHERE id = ?').bind(queued, searchId).run();
    }

    return c.json({
      queued,
      alreadyOnBoard: preview.matches.length - queued,
      historical: messages.filter((m) => m.kind === 'historical').length,
      writeMode,
    });
  });

  return app;
}
