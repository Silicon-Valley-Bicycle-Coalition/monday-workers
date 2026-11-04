// Shapes of the static reference files that scripts/build-reference.mjs writes to public/data/.
import type { GapClass } from '../score';

/** Properties of each feature in public/data/blockgroups.geojson. */
export interface BlockGroupProps {
  GEOID: string; // 12-digit block group id
  population: number; // ACS B01003_001E
  medianIncome: number | null; // ACS B19013_001E; negative sentinel → null
  epc: boolean; // the tract (GEOID.slice(0, 11)) is an MTC Equity Priority Community
  roadMiles: number;
  bikeMiles: { '1': number; '2': number; '3': number; '4': number };
  weightedBikeMiles: number;
  bikeDensity: number | null; // weightedBikeMiles / roadMiles; null when roadMiles === 0
  bikeClass: GapClass; // classify(bikeDensity over scored BGs, 'low-is-gap'); null under minPopulation
}

/** Properties of each feature in public/data/bikelanes.geojson. */
export interface BikeLaneProps {
  class: 1 | 2 | 3 | 4;
}

/** Properties of each feature in public/data/epc.geojson. */
export interface EpcProps {
  tract: string;
}

/** public/data/reference-meta.json */
export interface ReferenceMeta {
  builtAt: string;
  sources: { name: string; url: string; vintage: string }[];
}
