# SVBC Bike Lanes Tracker

A static website built with [11ty](https://www.11ty.dev/) that tracks the total miles of bike lanes in San Mateo and Santa Clara Counties. Data is sourced from MTC Regional Bike Facilities mapping data and updated weekly.

## Features

- **County-level totals** for San Mateo and Santa Clara Counties
- **Class type analysis** (Class I, II, III, IV bike facilities)
- **Historical tracking** to monitor progress over time
- **Weekly automated updates** via GitHub Actions

## Data Source

Data is fetched from the [MTC Regional Bike Facilities](https://opendata.mtc.ca.gov/datasets/regional-bike-facilities) ArcGIS REST API during each build.

### Data Limitations

The MTC Regional Bike Facilities dataset does not include city/jurisdiction attribution for bike lane segments. As a result, this site currently provides county-level and class-type breakdowns only.

## Future Enhancements

- **City-level breakdowns** - If a data source with city attribution becomes available
- **Interactive maps** - Visualize bike lane locations geographically

---

## TODO: Project Setup

### Phase 1: Project Initialization
- [x] Initialize npm project with package.json
- [x] Install 11ty and dependencies
- [x] Create basic 11ty directory structure
- [x] Set up .gitignore for Node.js/11ty project
- [x] Create initial 11ty config file (.eleventy.js)

### Phase 2: Data Fetching
- [x] Research MTC ArcGIS API endpoints for bike facilities
- [x] Identify the correct layer ID for Regional Bike Facilities
- [x] Create data fetching script to query bike lanes for San Mateo County
- [x] Create data fetching script to query bike lanes for Santa Clara County
- [x] Parse and aggregate data by:
  - [x] County
  - [x] Bike lane class type (I, II, III, IV)
- [x] Calculate total miles from geometry/length data
- [x] Save fetched data as JSON for 11ty to consume

### Phase 3: Historical Data Storage
- [x] Design JSON schema for historical data storage
- [x] Create script to append new data snapshots with timestamps
- [x] Store historical data in `_data/history.json`
- [x] Create 11ty data file to make history available to templates

### Phase 4: Templates & Pages
- [x] Create base layout template with HTML structure
- [x] Create homepage with summary dashboard
- [x] Create county breakdown table
- [x] Create bike lane class type breakdown table
- [x] Add historical trends section on homepage

### Phase 5: Styling & Branding
- [x] Source SVBC brand colors from bikesiliconvalley.org
- [x] Source/download SVBC logo
- [x] Create CSS stylesheet with SVBC branding
- [x] Style tables for readability
- [x] Ensure responsive design for mobile viewing
- [x] Add SVBC logo to header

### Phase 6: Polish & Documentation

- [x] Add data source attribution and methodology notes
- [x] Add last updated timestamp to site
- [ ] Test across browsers
- [x] Write deployment/maintenance documentation
- [x] Add link to SVBC main website

### Phase 7: Build & Deployment

- [ ] Create GitHub repository
- [ ] Set up GitHub Actions workflow for:
  - [ ] Weekly scheduled builds (cron)
  - [ ] Manual trigger option
  - [ ] Fetch fresh data during build
  - [ ] Commit updated historical data back to repo
  - [ ] Deploy to GitHub Pages
- [ ] Configure GitHub Pages settings
- [ ] Test full build pipeline

---

## Tech Stack

- **Static Site Generator:** 11ty (Eleventy)
- **Data Source:** MTC Regional Bike Facilities ArcGIS REST API
- **Hosting:** GitHub Pages
- **CI/CD:** GitHub Actions (weekly scheduled builds)
- **Styling:** CSS (no framework, SVBC branded)

## Bike Lane Class Types

| Class | Name | Description |
|-------|------|-------------|
| I | Bike Path | Separated from roadway, exclusive right-of-way |
| II | Bike Lane | Striped lane on roadway |
| III | Bike Route | Shared roadway with signage |
| IV | Separated Bikeway | Protected bike lane with physical barrier |

## Directory Structure (Planned)

```
svbc_bike_lanes/
├── _data/
│   ├── bikelanes.js      # Fetches current data at build time
│   └── history.json      # Historical snapshots
├── _includes/
│   └── layouts/
│       └── base.njk      # Base HTML template
├── src/
│   ├── index.njk         # Homepage
│   ├── css/
│   │   └── style.css     # SVBC-branded styles
│   └── assets/
│       └── svbc-logo.png # Logo file
├── .eleventy.js          # 11ty configuration
├── .github/
│   └── workflows/
│       └── build.yml     # GitHub Actions workflow
├── package.json
└── README.md
```

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

### GitHub Pages Setup

1. Push this repository to GitHub
2. Go to repository Settings > Pages
3. Set source to "GitHub Actions"
4. The included workflow will automatically build and deploy on push

### Manual Deployment

To deploy manually to any static hosting:

```bash
npm run build
# Upload contents of _site/ directory to your host
```

## Maintenance

### Data Updates

Data is fetched from the MTC API during each build. To update the site with fresh data:

1. **Automated**: The GitHub Actions workflow runs weekly (configured in `.github/workflows/build.yml`)
2. **Manual**: Trigger a manual workflow run from the Actions tab, or run `npm run build` locally

### Historical Data

Historical snapshots are stored in `_data/history.json`. This file is automatically updated during CI builds when the `CI` environment variable is set. The history tracks:

- Total miles by county
- Breakdown by bike lane class
- Date of each snapshot

### Adding New Counties

To add additional counties, modify `_data/bikelanes.js`:

1. Add the county name to the `COUNTIES` object with its FIPS code
2. The data fetching will automatically include the new county

## License

TBD

---

*Built for [Silicon Valley Bicycle Coalition](https://bikesiliconvalley.org)*
