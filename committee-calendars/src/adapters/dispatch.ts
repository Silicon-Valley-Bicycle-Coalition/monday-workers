import type { NormalizedEvent, SourceConfig } from '../types';
import { fetchLegistarEvents } from './legistar';
import { fetchCivicPlusEvents } from './civicplus';
import { fetchCaltrainBatacEvents } from './caltrainBatac';

export type FetchSourceEvents = (source: SourceConfig, now: Date) => Promise<NormalizedEvent[]>;

export const fetchSourceEvents: FetchSourceEvents = (source, now) => {
  switch (source.adapter) {
    case 'legistar':
      return fetchLegistarEvents(source, now);
    case 'civicplus':
      return fetchCivicPlusEvents(source);
    case 'caltrainBatac':
      return fetchCaltrainBatacEvents(source);
  }
};
