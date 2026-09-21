// Which deployment this isolate is: production (the default) or sandbox (`wrangler deploy --env
// sandbox`, which sets the ENVIRONMENT var). Mirrors donor-portal/src/environment.ts — kept as
// its own copy per this repo's "each Worker is self-contained" convention.
export type Environment = 'production' | 'sandbox';

export interface EnvironmentBindings {
  ENVIRONMENT?: string;
}

export function environmentOf(env: EnvironmentBindings): Environment {
  const value = env.ENVIRONMENT;
  if (value === undefined || value === '' || value === 'production') return 'production';
  if (value === 'sandbox') return 'sandbox';
  // Fail closed: an unrecognized name could be a typo'd "sandbox" about to hit production config.
  throw new Error(`ENVIRONMENT var must be "sandbox" or unset (production); got "${value}"`);
}

export interface WorkerConfig {
  feedbackFormUrl: string;
  fromAddress: string;
  fromName: string;
  // Absolute URL to the branded PNG logo — served by member-portal's GET /email/logo.png (this
  // Worker has no copy of its own), so this must point at the matching member-portal environment
  // (production vs sandbox), not necessarily this Worker's own.
  logoUrl: string;
}

export function configFor(env: EnvironmentBindings, production: WorkerConfig, sandbox: WorkerConfig): WorkerConfig {
  return environmentOf(env) === 'sandbox' ? sandbox : production;
}
