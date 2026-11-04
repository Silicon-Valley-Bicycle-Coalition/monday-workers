// Builds the one snapshot.json the page reads: each located record becomes a point, each point
// is counted into its Census block group, and every block group gets its gap classes. Counts
// only in logs, never names, addresses or ids.

import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { buildIndex, type BlockGroupIndex } from './assign';
import type { MapConfig } from './config';
import { resolveLocations, type GeocodeStore, type Geocoder, type LatLng } from './geocode';
import type { BoardKey, BoardRecord, MapMondayClient } from './monday/client';
import type { BlockGroupProps } from './reference/types';
import { classify, populationGapClasses, type GapClass } from './score';
import referenceConfig from '../config/reference.json';

export type PointKind = 'member' | 'lapsed' | 'never' | 'org';
export interface SnapshotPoint { id: string; boardId: number; name: string; lat: number; lng: number; kind: PointKind; dns: boolean }
export interface BlockGroupCounts { members: number; lapsed: number; never: number; popClass: GapClass; leadClass: GapClass }
export interface Snapshot {
  asOf: string; accountUrl: string; unplaced: number; outsideArea: number;
  blockGroups: Record<string, BlockGroupCounts>; points: SnapshotPoint[];
}

export const SNAPSHOT_KEY = 'snapshot.json';
const BLOCK_GROUPS_URL = 'https://assets.local/data/blockgroups.geojson';
const MIN_POPULATION = referenceConfig.minPopulation;
const BOARD_KEYS: BoardKey[] = ['peopleLive', 'peopleHistorical', 'organizations'];

export function kindOf(r: BoardRecord, labels: Pick<MapConfig, 'activeLabel' | 'lapsedLabel'>): PointKind {
  if (r.board === 'organizations') return 'org';
  if (r.membershipStatus === labels.activeLabel) return 'member';
  if (r.membershipStatus === labels.lapsedLabel) return 'lapsed';
  return 'never';
}

export function buildSnapshot(
  records: BoardRecord[], located: Map<string, LatLng>, unplaced: number, index: BlockGroupIndex,
  reference: BlockGroupProps[], cfg: MapConfig, minPopulation: number, now: Date,
): Snapshot {
  const tally = new Map<string, { members: number; lapsed: number; never: number }>();
  for (const bg of reference) tally.set(bg.GEOID, { members: 0, lapsed: 0, never: 0 });

  const points: SnapshotPoint[] = [];
  let outsideArea = 0;
  for (const r of records) {
    const at = located.get(r.itemId);
    if (!at) continue;
    const kind = kindOf(r, cfg);
    points.push({ id: r.itemId, boardId: r.boardId, name: r.name, lat: at.lat, lng: at.lng, kind, dns: r.doNotSolicit });
    const geoid = index.find(at.lng, at.lat);
    const counts = geoid === null ? undefined : tally.get(geoid);
    if (!counts) { outsideArea++; continue; }
    if (kind === 'member') counts.members++;
    else if (kind === 'lapsed') counts.lapsed++;
    else if (kind === 'never') counts.never++;
  }

  const popClasses = populationGapClasses(
    reference.map((bg) => ({ members: tally.get(bg.GEOID)?.members ?? 0, population: bg.population })), minPopulation,
  );
  const leadClasses = classify(
    reference.map((bg) => {
      const c = tally.get(bg.GEOID);
      return bg.population < minPopulation || !c ? null : c.lapsed + c.never;
    }), 'high-is-gap',
  );

  const blockGroups: Record<string, BlockGroupCounts> = {};
  reference.forEach((bg, i) => {
    const c = tally.get(bg.GEOID) ?? { members: 0, lapsed: 0, never: 0 };
    blockGroups[bg.GEOID] = { ...c, popClass: popClasses[i] ?? null, leadClass: leadClasses[i] ?? null };
  });

  return { asOf: now.toISOString(), accountUrl: cfg.monday.accountUrl, unplaced, outsideArea, blockGroups, points };
}

export async function runRefresh(deps: {
  monday: MapMondayClient; store: GeocodeStore; geocoder: Geocoder;
  assets: Fetcher; bucket: R2Bucket; config: MapConfig; now: Date;
}): Promise<Snapshot> {
  const { config } = deps;

  const records: BoardRecord[] = [];
  for (const board of BOARD_KEYS) {
    const boardId = config.boards[board];
    if (boardId === 0) { console.log(`member-map: ${board} board id not configured`); continue; }
    records.push(...(await deps.monday.readBoard(board, boardId, config.columns)));
  }

  const res = await deps.assets.fetch(new Request(BLOCK_GROUPS_URL));
  if (!res.ok) throw new Error(`member-map: block group data returned ${res.status}`);
  const fc = (await res.json()) as FeatureCollection<Polygon | MultiPolygon, BlockGroupProps>;
  const refProps = fc.features.map((f) => f.properties);

  const { located, unplaced, geocoded } = await resolveLocations(records, deps.store, deps.geocoder, config.geocoder, deps.now);
  const snapshot = buildSnapshot(records, located, unplaced, buildIndex(fc), refProps, config, MIN_POPULATION, deps.now);

  await deps.bucket.put(SNAPSHOT_KEY, JSON.stringify(snapshot), { httpMetadata: { contentType: 'application/json' } });
  console.log(
    `member-map: snapshot records=${records.length} located=${located.size} geocoded=${geocoded} unplaced=${unplaced} outsideArea=${snapshot.outsideArea}`,
  );
  return snapshot;
}
