# SVBC Bike Lanes Tracker

A static website built with [11ty](https://www.11ty.dev/) that tracks the total miles of bike lanes in San Mateo and Santa Clara Counties. Data is sourced from MTC Regional Bike Facilities mapping data and updated weekly.

## Features

- **Regional totals** with breakdown by bike lane class (I, II, III, IV)
- **City-level breakdown** for all cities in San Mateo and Santa Clara Counties
- **Class IV supplemental data** from San Jose Open Data (MTC doesn't track Class IV)
- **Historical tracking** to monitor progress over time
- **CSV data exports** in miles and kilometers
- **Weekly automated updates** via Woodpecker CI

## Data Sources

- **Primary:** [MTC Regional Bike Facilities](https://opendata.mtc.ca.gov/datasets/regional-bike-facilities) ArcGIS REST API
- **Supplemental:** [San Jose Open Data - Bikeways](https://data.sanjoseca.gov/dataset/bikeways) for Class IV separated bikeways
- **City Boundaries:** US Census TIGER/Line data for spatial attribution

## Tech Stack

- **Static Site Generator:** 11ty (Eleventy)
- **Hosting:** Cloudflare Pages
- **CI/CD:** Woodpecker CI on Codeberg (weekly scheduled builds)
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

### Codeberg + Cloudflare Pages Setup

1. **Create Codeberg Repository**
   ```bash
   git remote add origin https://codeberg.org/YOUR_USERNAME/svbc-bike-lanes.git
   git push -u origin main
   ```

2. **Enable Woodpecker CI**
   - Go to your repo on Codeberg
   - Navigate to Settings → Integrations → Woodpecker CI
   - Enable the integration

3. **Create Cloudflare Pages Project**
   - Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → Pages
   - Create a new project named `svbc-bike-lanes`
   - Note: We'll deploy via Wrangler CLI, not Git integration

4. **Configure CI Secrets**
   In Woodpecker CI settings, add these secrets:
   - `cloudflare_account_id` - Your Cloudflare account ID
   - `cloudflare_api_token` - API token with Pages edit permissions
   - `codeberg_token` - Personal access token for committing history updates

5. **Set Up Weekly Cron**
   In Woodpecker CI, create a cron job named `weekly` that runs on your preferred schedule (e.g., every Monday at 6 AM).

### Manual Deployment

```bash
npm run build
npx wrangler pages deploy _site --project-name=svbc-bike-lanes
```

## Maintenance

### Data Updates

Data is fetched from the MTC API during each build. To update the site with fresh data:

1. **Automated**: Woodpecker CI runs weekly via cron
2. **Manual**: Push to main branch or trigger a build in Woodpecker CI

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
├── .woodpecker/
│   └── build.yml              # Woodpecker CI workflow
├── .eleventy.js               # 11ty configuration
├── package.json
└── README.md
```

## License

MIT

---

*Built for [Silicon Valley Bicycle Coalition](https://bikesiliconvalley.org)*
