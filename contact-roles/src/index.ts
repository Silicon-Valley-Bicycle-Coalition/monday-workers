import type { Env } from './types.ts';

export default {
  // No HTTP surface: the Worker only runs on its cron trigger.
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },

  // Placeholder; the reconcile run lands in a later task.
  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    console.log('contact-roles: scheduled run (not yet implemented)');
  },
} satisfies ExportedHandler<Env>;
