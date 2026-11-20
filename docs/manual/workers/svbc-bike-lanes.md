# svbc-bike-lanes

[Appendix A](../reference/svbc-bike-lanes.md) lists this Worker's routes, crons, queues, storage and bindings.

Deployed as `svbc-bike-lanes` on the custom domain `lanes.bikesiliconvalley.org`, behind Cloudflare
Access (staff only). It is a static site with no Worker script and no Monday access, and it isn't
part of the CRM migration. It moved here from its own GitLab repository and from Cloudflare Pages
in November 2026. There is no sandbox copy.

## What it does

A one-page tracker of bike lane miles in San Mateo and Santa Clara Counties, by county, city and
lane class (I to IV), with a weekly history and CSV downloads in miles and kilometers. If it stops
updating, staff see stale totals; nothing else depends on it.

## Trigger and data flow

Everything happens at build time in GitHub Actions (`.github/workflows/svbc-bike-lanes.yml`); the
deployed Worker only serves files.

1. The workflow runs weekly (Saturdays 06:47 UTC), on a push to `main` that touches
   `svbc-bike-lanes/`, or by hand (Actions → svbc-bike-lanes → Run workflow).
2. It loads `history.json` from the `svbc-bike-lanes-history` branch.
3. Eleventy builds the site. `_data/bikelanes.js` queries MTC Regional Bike Facilities, San José's
   bikeways (Class IV), CA Open Data city boundaries and Census TIGERweb county boundaries, clips
   each segment to county and city lines, and appends today's snapshot to the history.
4. `wrangler deploy` uploads `_site/` as the Worker's static assets.
5. On scheduled and manual runs, the new `history.json` is committed to the history branch.

## Monday boards and columns

None. The site doesn't read or write Monday.

## Secrets

`CLOUDFLARE_API_TOKEN`, a secret of the GitHub `svbc-bike-lanes` environment (restricted to
`main`). It needs the Workers Editor role scoped to the `svbc-bike-lanes` Worker and Workers
Routes: Write on the `bikesiliconvalley.org` zone. Without it the workflow builds and records
history but skips the deploy. The Worker itself has no secrets.

## Write switch

None. The site writes nothing outside its own history branch.

## Failure modes

- **An ArcGIS service is down or changed:** the build fails, nothing deploys, and the live site
  keeps last week's data. The failed run shows in Actions; re-run it once the service is back.
- **Token missing or expired:** the run succeeds with a "skipping the deploy" notice, so the site
  silently goes stale. Check the latest run's summary if the page's "updated" date is old.
- **Access misconfigured:** the site is public. Access must cover `lanes.bikesiliconvalley.org`;
  `workers_dev` and `preview_urls` are off so the custom domain is the only hostname.

## Operator scripts

None. Build and deploy by hand from `svbc-bike-lanes/` with `npm run build` and
`npm run deploy`. A local build doesn't append to the history unless `CI=true` is set.

## Changing it

Edit the Eleventy source in `svbc-bike-lanes/` (data loaders in `_data/`, template in `src/` and
`_includes/`), run `npm test`, and open a PR. Merging redeploys. To add a county or Class IV
source, see [`svbc-bike-lanes/README.md`](../../../svbc-bike-lanes/README.md), "Maintenance".

## Further reading

- [`svbc-bike-lanes/README.md`](../../../svbc-bike-lanes/README.md): data sources, counting
  method, Access setup, deployment.
- `.github/workflows/svbc-bike-lanes.yml`: the build, deploy and history steps.
