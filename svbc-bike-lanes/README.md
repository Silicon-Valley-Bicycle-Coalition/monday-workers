# SVBC Bike Lanes Tracker

A static website built with [11ty](https://www.11ty.dev/) that tracks the total miles of bike lanes in San Mateo and Santa Clara Counties. Data is sourced from MTC Regional Bike Facilities mapping data and updated weekly.

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
- **City Boundaries:** US Census TIGER/Line data for spatial attribution

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
   - Interval pattern: `0 6 * * 1` (Mondays at 6 AM UTC)
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

1. Add the county name to the `COUNTIES` object with its FIPS code and bounding box
2. The data fetching will automatically include the new county

## Directory Structure

```
svbc_bike_lanes/
├── _data/
│   ├── bikelanes.js           # Fetches MTC data at build time
│   ├── cityBoundaries.js      # Census TIGER city boundaries
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
