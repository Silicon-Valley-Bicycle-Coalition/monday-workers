import { Hono } from 'hono';
import type { Env, WriteMessage } from './types';

export type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// Unauthenticated liveness probe; every other route sits behind Cloudflare Access.
app.get('/health', (c) => c.text('ok'));

export default {
  fetch: app.fetch,

  async queue(_batch: MessageBatch<WriteMessage>, _env: Env): Promise<void> {
    throw new Error('nearby-search queue consumer: not implemented');
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    throw new Error('nearby-search scheduled geocode: not implemented');
  },
};
