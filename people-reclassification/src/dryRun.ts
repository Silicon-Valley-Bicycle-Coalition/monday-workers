// Every Monday mutation this Worker can make is off unless DRY_RUN is exactly "false". The var
// is set per environment in wrangler.jsonc; an HTTP trigger can pass ?dryRun=false to run one
// live pass without a redeploy (src/routes.ts), which is how the first real moves get proven in
// the sandbox one pass at a time.
export function isDryRun(env: { DRY_RUN?: string }): boolean {
  return env.DRY_RUN !== 'false';
}
