import { Hono } from 'hono';

export interface Env {
  MONDAY_API_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
};
