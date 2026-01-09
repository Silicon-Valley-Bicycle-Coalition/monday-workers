# SVBC Bike Lanes Tracker

A static website built with [11ty](https://www.11ty.dev/) that tracks the total miles of bike lanes in San Mateo and Santa Clara Counties. Data is sourced from MTC Regional Bike Facilities mapping data and updated weekly.

## Features

- **County-level totals** for San Mateo and Santa Clara Counties
- **City-level breakdowns** showing bike lane miles per municipality
- **Class type analysis** (Class I, II, III, IV bike facilities)
- **Historical tracking** to monitor progress over time
- **SVBC branding** consistent with Silicon Valley Bicycle Coalition identity

## Data Source

Data is fetched from the [MTC Regional Bike Facilities](https://opendata.mtc.ca.gov/datasets/regional-bike-facilities) ArcGIS REST API during each build.

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
  - [ ] City/jurisdiction (deferred - data source lacks city field)
  - [x] Bike lane class type (I, II, III, IV)
- [x] Calculate total miles from geometry/length data
- [x] Save fetched data as JSON for 11ty to consume

### Phase 3: Historical Data Storage
- [ ] Design JSON schema for historical data storage
- [ ] Create script to append new data snapshots with timestamps
- [ ] Store historical data in `_data/history.json` (or similar)
- [ ] Create 11ty data file to make history available to templates

### Phase 4: Templates & Pages
- [x] Create base layout template with HTML structure
- [x] Create homepage with summary dashboard
- [x] Create county breakdown table
- [ ] Create city-level breakdown table (deferred - data source lacks city field)
- [x] Create bike lane class type breakdown table
- [ ] Add historical trends section/page

### Phase 5: Styling & Branding
- [ ] Source SVBC brand colors from bikesiliconvalley.org
- [ ] Source/download SVBC logo
- [ ] Create CSS stylesheet with SVBC branding
- [ ] Style tables for readability
- [ ] Ensure responsive design for mobile viewing
- [ ] Add SVBC logo to header

### Phase 6: Build & Deployment
- [ ] Create GitHub repository
- [ ] Set up GitHub Actions workflow for:
  - [ ] Weekly scheduled builds (cron)
  - [ ] Manual trigger option
  - [ ] Fetch fresh data during build
  - [ ] Commit updated historical data back to repo
  - [ ] Deploy to GitHub Pages
- [ ] Configure GitHub Pages settings
- [ ] Test full build pipeline

### Phase 7: Polish & Documentation
- [ ] Add data source attribution and methodology notes
- [ ] Add last updated timestamp to site
- [ ] Test across browsers
- [ ] Write deployment/maintenance documentation
- [ ] Add link to SVBC main website

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

## License

TBD

---

*Built for [Silicon Valley Bicycle Coalition](https://bikesiliconvalley.org)*
