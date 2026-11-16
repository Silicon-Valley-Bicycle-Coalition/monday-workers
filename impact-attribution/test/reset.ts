import { env } from 'cloudflare:workers';

// D1 storage persists across tests in this runner; each test that touches the database starts
// from empty tables.
export async function resetDb(): Promise<void> {
  await env.DB.batch([env.DB.prepare('DELETE FROM matches'), env.DB.prepare('DELETE FROM proposals')]);
}
