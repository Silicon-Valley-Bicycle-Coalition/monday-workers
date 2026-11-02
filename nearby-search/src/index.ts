import { configFor } from './config';
import { createOsmClient } from './locate/osm';
import { HttpNearbyMondayClient } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import { buildApp } from './routes';
import type { Env, WriteMessage } from './types';

export type { Env } from './types';

const app = buildApp((env) => {
  const config = configFor(env);
  return {
    config,
    osm: createOsmClient(config.osm),
    monday: new HttpNearbyMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
  };
});

export default {
  fetch: app.fetch,

  async queue(_batch: MessageBatch<WriteMessage>, _env: Env): Promise<void> {
    throw new Error('nearby-search queue consumer: not implemented');
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    throw new Error('nearby-search scheduled geocode: not implemented');
  },
};
