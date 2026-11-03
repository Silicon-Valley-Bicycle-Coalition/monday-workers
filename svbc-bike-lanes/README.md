# SVBC Bike Lanes Tracker

A static website built with [11ty](https://www.11ty.dev/) that tracks the total miles of bike lanes in San Mateo and Santa Clara Counties. Data is sourced from MTC Regional Bike Facilities mapping data and updated weekly.

The site is **staff-only**: it's served at <https://lanes.bikesiliconvalley.org> behind Cloudflare Access, and only `@bikesiliconvalley.org` Google Workspace accounts can open it (see [Access](#access-staff-only)).

## Features

- **Regional totals** with breakdown by bike lane class (I, II, III, IV)
- **City-level breakdown** for all cities in San Mateo and Santa Clara Counties
- **Class IV supplemental data** from San Jose Open Data (MTC doesn't track Class IV)
- **Historical tracking** to monitor progress over time
- **CSV data exports** in miles and kilometers
- **Weekly automated updates** via GitLab CI/CD

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
- **Hosting:** Cloudflare Pages
- **CI/CD:** GitLab CI/CD (weekly scheduled pipelines)
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
```

## Deployment

### GitLab + Cloudflare Pages Setup

#### 1. Create Cloudflare Pages Project

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → Pages
2. Click **Create a project** → **Connect to Git**
3. Select your GitLab repository
4. Configure build settings:
   - **Build command:** `npm run build`
   - **Build output directory:** `_site`
   - **Root directory:** `/` (leave default)
   - **Environment variables:** Add `CI=true` (required for history tracking)

#### 2. Configure GitLab CI/CD

The `.gitlab-ci.yml` is already configured with build, deploy, and history update stages. You just need to:

1. **Add CI/CD Variables** (Settings → CI/CD → Variables):
   - `CLOUDFLARE_API_TOKEN` - API token with Cloudflare Pages edit permissions
   - `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID
   - `GITLAB_TOKEN` - Project Access Token with `write_repository` scope (for history commits)

2. **Create a Pipeline Schedule** (Build → Pipeline schedules):
   - Click **New schedule**
   - Description: "Weekly data update"
   - Interval pattern: `47 22 * * 5`, timezone `America/Los_Angeles` (Fridays at 10:47 PM Pacific; the live schedule)
   - Target branch: `main`
   - Activate the schedule

#### Alternative: Cloudflare Pages Direct Integration

For simpler setup without GitLab CI deployment:

1. Connect Cloudflare Pages directly to GitLab
2. Set build command: `npm run build`
3. Set output directory: `_site`
4. Add environment variable: `CI=true`

**Note:** With direct integration, you'll need to trigger rebuilds manually or use Cloudflare's Deploy Hooks for scheduled updates.

#### Cloudflare Deploy Hooks (for scheduled rebuilds)

1. In Cloudflare Pages project settings, create a **Deploy Hook**
2. Use an external scheduler (cron job, GitHub Actions, etc.) to call the hook weekly:

   ```bash
   curl -X POST "https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/YOUR_HOOK_ID"
   ```

### Access (staff-only)

The site sits behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) on SVBC's Cloudflare account. Every hostname that serves it requires a Google Workspace login with an `@bikesiliconvalley.org` address. The Zero Trust organization and Google identity provider are shared with SVBC's other staff-only tools (for example the `member-map` Worker in `monday-workers`), so set them up once, not per site.

| Piece | Setting |
|-------|---------|
| Zero Trust team domain | `bikesiliconvalley.cloudflareaccess.com` |
| Identity provider | Google Workspace, apps domain `bikesiliconvalley.org` |
| Access application | **SVBC Bike Lanes** (self-hosted) |
| Hostnames covered | `lanes.bikesiliconvalley.org`, `svbc-bike-lanes.pages.dev`, `*.svbc-bike-lanes.pages.dev` |
| Login methods | Google Workspace only, instant auth |
| Session duration | 24 hours (someone removed from Workspace loses access when their session expires) |
| Policy | **Allow**, Include: Emails ending in `@bikesiliconvalley.org` |

All three hostnames must be on the application. Pages serves every build on `svbc-bike-lanes.pages.dev` and on a per-deployment `<hash>.svbc-bike-lanes.pages.dev` URL as well as the custom domain. If only the custom domain is protected, anyone can open the site through the `pages.dev` URLs.

#### Recreating it (for example on a fork)

1. **Google OAuth client.** In [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services, set the OAuth consent screen to **Internal**. Then create an **OAuth client ID** (type: Web application) with:
   - Authorized JavaScript origin: `https://<team>.cloudflareaccess.com`
   - Authorized redirect URI: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
2. **Identity provider.** In [Zero Trust](https://one.dash.cloudflare.com/) → Integrations → Identity providers → **Add** → **Google Workspace**, enter the client ID, the client secret, and your Workspace domain. Click **Test** before saving.
3. **Access application.** In Zero Trust → Access → Applications → **Add an application** → **Self-hosted**:
   - Add the custom domain, `<project>.pages.dev`, and `*.<project>.pages.dev` as public hostnames.
   - Under Login methods, allow only Google Workspace and turn on **Instant Auth** to skip the provider picker.
   - Add an **Allow** policy with Include → *Emails ending in* → `@<your-domain>`.
4. **Check.** In a private window, each hostname should redirect to the Google login. From a shell, the `pages.dev` hostnames should return a `302` to `<team>.cloudflareaccess.com`. The custom domain gives curl a `403` bot challenge ("Just a moment...") from the zone's security settings before Access runs, so check it in a browser.

   ```bash
   for h in svbc-bike-lanes.pages.dev <any-deploy-hash>.svbc-bike-lanes.pages.dev; do curl -sI "https://$h/" | grep -iE '^(HTTP|location)'; done
   ```

Access doesn't affect deploys. `wrangler pages deploy` uploads through the Cloudflare API using `CLOUDFLARE_API_TOKEN`, not through the protected hostnames, so the GitLab CI pipeline needs no Access service token.

### Manual Deployment

```bash
npm run build
npx wrangler pages deploy _site --project-name=svbc-bike-lanes
```

## Maintenance

### Data Updates

Data is fetched from the MTC API during each build. To update the site with fresh data:

1. **Automated**: GitLab CI runs weekly via scheduled pipelines
2. **Manual**: Push to main branch or trigger a pipeline in GitLab CI/CD

### Historical Data

Historical snapshots are stored in `_data/history.json`. This file is automatically updated during CI builds when the `CI` environment variable is set. The history tracks:

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
svbc_bike_lanes/
├── _data/
│   ├── bikelanes.js           # Fetches MTC data at build time
│   ├── arcgis.js              # Paged ArcGIS REST queries
│   ├── cityBoundaries.js      # CA Open Data city boundaries
│   ├── countyBoundaries.js    # Census TIGERweb county boundaries
│   ├── clipping.js            # Cuts segments at county/city lines
│   ├── supplementalSources.js # Class IV data from city sources
│   ├── csvExport.js           # CSV generation
│   └── history.json           # Historical snapshots
├── _includes/
│   └── layouts/
│       └── base.njk           # Base HTML template
├── src/
│   ├── index.njk              # Homepage
│   ├── css/
│   │   └── style.css          # SVBC-branded styles
│   └── assets/
│       └── svbc-logo.webp     # Logo file
├── .gitlab-ci.yml             # GitLab CI/CD configuration
├── .eleventy.js               # 11ty configuration
├── package.json
└── README.md
```

## License

MIT

---

*Built for [Silicon Valley Bicycle Coalition](https://bikesiliconvalley.org)*
