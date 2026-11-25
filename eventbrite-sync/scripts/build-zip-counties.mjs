#!/usr/bin/env node
// Prints attendeeSync.zipCounty.lists for both configs. Reads local files only.
//
// Usage (from eventbrite-sync/):
//   node scripts/build-zip-counties.mjs --census <zcta_county_rel_10.txt>

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArg } from './backfill-orders-lib.mjs';
import { zipCounties } from './zip-counties-lib.mjs';

const path = readArg(process.argv, '--census', null);
if (path === null) {
  console.error('build-zip-counties: --census <path to the Census 2010 ZCTA-to-county relationship file> is required');
  process.exit(1);
}
const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'svbc.json'), 'utf8'));
const known = new Set(Object.values(config.pledge.zipCounty).flat());
console.log(JSON.stringify(zipCounties(readFileSync(path, 'utf8'), known), null, 2));
