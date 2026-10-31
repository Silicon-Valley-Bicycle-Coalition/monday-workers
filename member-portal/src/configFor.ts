import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector } from './environment';
import { validateConfig } from './config';
import type { Config } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate. Production's config/svbc.json still ships with placeholder ids until an operator
// fills them in, so validation cannot run at import time — see validateConfig's placeholder check.
// Shared by the portal (index.ts) and member-portal-writer (writer.ts).
export const configFor = createConfigSelector<Config>({
  production: productionConfig,
  sandbox: sandboxConfig,
  validate: validateConfig,
});
