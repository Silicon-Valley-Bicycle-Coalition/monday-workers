// Which deployment this isolate is: production (the default — the top level of wrangler.jsonc)
// or sandbox (`wrangler deploy --env sandbox`, which sets the ENVIRONMENT var). The sandbox is a
// permanent parallel environment that runs against the CRM Sandbox boards and must never emit
// data to a donor or a vendor's production account — see
// ../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md.
export type Environment = 'production' | 'sandbox';

// The one var this module reads. Declared as its own interface so the entrypoint's full Env can
// be passed in and tests can pass a bare object.
export interface EnvironmentBindings {
  ENVIRONMENT?: string;
}

export function environmentOf(env: EnvironmentBindings): Environment {
  const value = env.ENVIRONMENT;
  if (value === undefined || value === '' || value === 'production') return 'production';
  if (value === 'sandbox') return 'sandbox';
  // Fail closed: an unrecognized name could be a typo'd "sandbox" about to hit production ids.
  throw new Error(`ENVIRONMENT var must be "sandbox" or unset (production); got "${value}"`);
}

export interface ConfigSources<T> {
  production: unknown;
  sandbox: unknown;
  validate: (raw: unknown) => T;
}

// Returns a `configFor(env)` function. Config was previously a module-scope import of one JSON
// file; with two files the choice can only happen once `env` is in hand (a handler), so this
// memoizes per environment to keep validation at once-per-isolate rather than once-per-request.
// A throwing validation is not memoized: the next request throws again, matching the existing
// "fail loudly on placeholder config" behavior.
export function createConfigSelector<T>(sources: ConfigSources<T>): (env: EnvironmentBindings) => T {
  const memo = new Map<Environment, T>();
  return (env) => {
    const environment = environmentOf(env);
    if (memo.has(environment)) return memo.get(environment) as T;
    const config = sources.validate(environment === 'sandbox' ? sources.sandbox : sources.production);
    memo.set(environment, config);
    return config;
  };
}
