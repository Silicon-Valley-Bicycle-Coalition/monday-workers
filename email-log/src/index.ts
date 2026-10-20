import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { D1LoggedMessageStore } from './db/loggedMessages';
import { validateConfig } from './config';
import { createConfigSelector } from './environment';
import { handleEmail } from './inbound/handleEmail';
import type { Env } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, {
      config: configFor(env),
      store: new D1LoggedMessageStore(env.DB),
      queue: env.WRITE_QUEUE,
      now: () => new Date(),
    });
  },

  // Implemented in a later task.
  async queue(): Promise<void> {
    throw new Error('not implemented');
  },
};
