# SVBC Bike Lanes Tracker

A static website built with [11ty](https://www.11ty.dev/) that tracks the total miles of bike lanes in San Mateo and Santa Clara Counties. Data is sourced from MTC Regional Bike Facilities mapping data and updated weekly.

The site is **staff-only**: it's served at <https://lanes.bikesiliconvalley.org> behind Cloudflare Access, and only `@bikesiliconvalley.org` Google Workspace accounts can open it (see [Access](#access-staff-only)).

## Features

- **Regional totals** with breakdown by bike lane class (I, II, III, IV)
- **City-level breakdown** for all cities in San Mateo and Santa Clara Counties
- **Class IV supplemental data** from San Jose Open Data (MTC doesn't track Class IV)
- **Historical tracking** to monitor progress over time
- **CSV data exports** in miles and kilometers
- **Weekly automated updates** via GitHub Actions

## Data Sources

- **Primary:** [MTC Regional Bike Facilities](https://opendata.mtc.ca.gov/datasets/regional-bike-facilities) ArcGIS REST API
- **Supplemental:** [San Jose Open Data - Bikeways](https://data.sanjoseca.gov/dataset/bikeways) for Class IV separated bikeways
- **City Boundaries:** [California Cities and Identifiers](https://gis.data.ca.gov/) (CA Open Data) for city attribution
- **County Boundaries:** US Census TIGERweb (legal boundaries, including bay waters)

### How miles are counted

Every MTC segment is cut wherever it crosses a county or city boundary, and each piece is counted in the county and city it lies in (or the county's unincorporated area). Pieces outside San Mateo and Santa Clara Counties are dropped, so lines in San Francisco, Alameda, or Santa Cruz County don't count, and no mile is counted twice. Every ArcGIS query is paged, so results past a service's 2,000-record limit aren't silently cut off.

San José's own bikeway inventory replaces the MTC data inside San José city limits. Records the city marks as outside its limits (`INCORPORATED = 'No'`) are left out there, since MTC already counts them in unincorporated Santa Clara County.

## Tech Stack

- **Static Site Generator:** 11ty (Eleventy)
- **Hosting:** Cloudflare Workers (static assets only)
- **CI/CD:** GitHub Actions (weekly schedule)
- **Styling:** CSS (no framework, SVBC branded)

## Bike Lane Class Types

| Class | Name | Description |
|-------|------|-------------|
| I | Bike Path | Separated from roadway, exclusive right-of-way |
| II | Bike Lane | Striped lane on roadway |
| III | Bike Route | Shared roadway with signage |
| IV | Separated Bikeway | Protected bike lane with physical barrier |

## Local Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Unit tests (boundary clipping)
npm test

# Serve the build as the Worker would
npx wrangler dev
```

## Deployment

The site is a [static-assets-only Cloudflare Worker](https://developers.cloudflare.com/workers/static-assets/) named `svbc-bike-lanes` (`wrangler.jsonc`), on the custom domain `lanes.bikesiliconvalley.org`. It moved from Cloudflare Pages and its own GitLab repository into `monday-workers` in November 2026. `workers_dev` and `preview_urls` are off, so the custom domain is the only hostname that serves it.

### GitHub Actions

`.github/workflows/svbc-bike-lanes.yml` (at the repository root) builds and deploys the site:

| Trigger | Builds and deploys | Records a history snapshot |
|---|---|---|
| Weekly, Saturdays 06:47 UTC (Friday night Pacific) | Yes | Yes |
| Push to `main` touching `svbc-bike-lanes/` | Yes | No |
| Manual (Actions → svbc-bike-lanes → Run workflow) | Yes | Yes |

The deploy uses `CLOUDFLARE_API_TOKEN`, a secret of the GitHub `svbc-bike-lanes` environment. Restrict that environment to the `main` branch, and mint it as an account API token with two policies: **Workers → Specified Workers → `svbc-bike-lanes`** with the **Editor** role (the dashboard lists it as "Individual Workers Editor"), and **Zone → `bikesiliconvalley.org` → Workers Routes: Write** (custom domains don't support per-Worker roles yet). Don't start from the dashboard's "Edit Cloudflare Workers" template, which adds account-wide grants including log access to every Worker. Creating the Worker needs Workers Admin, so the first deploy is by hand. Until the secret exists the workflow builds and records history but skips the deploy, with a notice in the run summary.

Don't also connect the Worker to Workers Builds: that would be a second deploy path, and it has no weekly schedule.

### Cutover from Pages (done 2026-11-20)

The move ran in this order; a fork moving off Pages can follow it.

1. Paused the GitLab "Weekly data update" schedule and archived the GitLab repository (now the read-only record).
2. Disconnected the Pages project's Git repository.
3. Removed `lanes.bikesiliconvalley.org` from the Pages project's custom domains. This also deletes the `lanes` CNAME, which has to go before a Worker Custom Domain can take the hostname. The site is down from here until step 4 (about a minute).
4. First deploy by hand, signed in with `wrangler login` (creating the Worker needs Workers Admin): `npm ci && npm run build && npm run deploy`. It attached the custom domain and its DNS record.
5. Deleted the Pages project, which took the `pages.dev` URLs with it.
6. Only then removed the `pages.dev` hostnames from the **SVBC Bike Lanes** Access application. Doing this before step 5 would leave `svbc-bike-lanes.pages.dev` public.
7. Added the GitHub `svbc-bike-lanes` environment's `CLOUDFLARE_API_TOKEN` and ran the workflow by hand: it deployed and created the `svbc-bike-lanes-history` branch.

### Manual Deployment

```bash
npm run build
npm run deploy
```

### Access (staff-only)

The site sits behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) on SVBC's Cloudflare account. Every hostname that serves it requires a Google Workspace login with an `@bikesiliconvalley.org` address. The Zero Trust organization and Google identity provider are shared with SVBC's other staff-only tools (for example the `member-map` Worker in `monday-workers`), so set them up once, not per site.

| Piece | Setting |
|-------|---------|
| Zero Trust team domain | `bikesiliconvalley.cloudflareaccess.com` |
| Identity provider | Google Workspace, apps domain `bikesiliconvalley.org` |
| Access application | **SVBC Bike Lanes** (self-hosted) |
| Hostnames covered | `lanes.bikesiliconvalley.org` |
| Login methods | Google Workspace only, instant auth |
| Session duration | 24 hours (someone removed from Workspace loses access when their session expires) |
| Policy | **Allow**, Include: Emails ending in `@bikesiliconvalley.org` |

The custom domain is the only hostname. If `workers_dev` or `preview_urls` were turned on, the site would also answer on `*.workers.dev` hostnames, and those would need to be on the application too.

#### Recreating it (for example on a fork)

1. **Google OAuth client.** In [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services, set the OAuth consent screen to **Internal**. Then create an **OAuth client ID** (type: Web application) with:
   - Authorized JavaScript origin: `https://<team>.cloudflareaccess.com`
   - Authorized redirect URI: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
2. **Identity provider.** In [Zero Trust](https://one.dash.cloudflare.com/) → Integrations → Identity providers → **Add** → **Google Workspace**, enter the client ID, the client secret, and your Workspace domain. Click **Test** before saving.
3. **Access application.** In Zero Trust → Access → Applications → **Add an application** → **Self-hosted**:
   - Add the custom domain as the public hostname.
   - Under Login methods, allow only Google Workspace and turn on **Instant Auth** to skip the provider picker.
   - Add an **Allow** policy with Include → *Emails ending in* → `@<your-domain>`.
4. **Check.** In a private window, the site should redirect to the Google login. Check in a browser: the zone's security settings give curl a `403` bot challenge ("Just a moment...") before Access runs.

Access doesn't affect deploys. `wrangler deploy` uploads through the Cloudflare API using `CLOUDFLARE_API_TOKEN`, not through the protected hostname, so the workflow needs no Access service token.

## Maintenance

### Data Updates

Data is fetched from the MTC API during each build. To update the site with fresh data:

1. **Automated**: the GitHub Actions workflow runs weekly
2. **Manual**: merge a change to `main`, or run the workflow by hand

### Historical Data

Historical snapshots live in `history.json` on the `svbc-bike-lanes-history` branch, which holds only that file: `main` needs a pull request, so the weekly run can't commit there. Each workflow run copies the branch's file over `_data/history.json` before building, and the build appends a snapshot when the `CI` environment variable is set. The copy of `_data/history.json` on `main` is only the seed used before the branch exists (it stops at the November 2026 move). To see current history locally, run `git show origin/svbc-bike-lanes-history:history.json > _data/history.json`. The history tracks:

- Total miles by county
- Breakdown by bike lane class
- Date of each snapshot

### Adding Supplemental Data Sources

To add Class IV data from additional cities, modify `_data/supplementalSources.js`:

1. Add a new fetch function for the city's open data API
2. Register it in the `SOURCES` array
3. The data will be merged automatically during build

### Adding New Counties

To add additional counties, modify `_data/bikelanes.js`:

1. Add the county name and FIPS code to `COUNTIES` in `_data/bikelanes.js`
2. Add the same pair to `TARGET_COUNTIES` in `_data/countyBoundaries.js`, and the county to the city query in `_data/cityBoundaries.js`
3. Delete `_data/*.cache.json` so the boundaries are re-fetched. MTC segments are clipped to the new county's TIGERweb boundary automatically

## Directory Structure

```
svbc-bike-lanes/
├── _data/
│   ├── bikelanes.js           # Fetches MTC data at build time
│   ├── arcgis.js              # Paged ArcGIS REST queries
│   ├── cityBoundaries.js      # CA Open Data city boundaries
│   ├── countyBoundaries.js    # Census TIGERweb county boundaries
│   ├── clipping.js            # Cuts segments at county/city lines
│   ├── supplementalSources.js # Class IV data from city sources
│   ├── csvExport.js           # CSV generation
│   └── history.json           # Seed history (live copy: svbc-bike-lanes-history branch)
├── _includes/
│   └── layouts/
│       └── base.njk           # Base HTML template
├── src/
│   ├── index.njk              # Homepage
│   ├── css/
│   │   └── style.css          # SVBC-branded styles
│   └── assets/
│       └── svbc-logo.webp     # Logo file
├── test/                      # node:test unit tests (npm test)
├── wrangler.jsonc             # Worker config: static assets, custom domain
├── .eleventy.js               # 11ty configuration
├── package.json
└── README.md
```

## License

MIT

---

*Built for [Silicon Valley Bicycle Coalition](https://bikesiliconvalley.org)*
