import type { NormalizedEvent, SourceConfig } from '../types';
import { fetchLegistarEvents } from './legistar';
import { fetchCivicPlusEvents } from './civicplus';
import { fetchCaltrainBatacEvents } from './caltrainBatac';
import { fetchEventbriteEvents } from './eventbrite';

export type FetchSourceEvents = (source: SourceConfig, now: Date) => Promise<NormalizedEvent[]>;

export function createFetchSourceEvents(eventbriteToken: string): FetchSourceEvents {
  return (source, now) => {
    switch (source.adapter) {
      case 'legistar':
        return fetchLegistarEvents(source, now);
      case 'civicplus':
        return fetchCivicPlusEvents(source);
      case 'caltrainBatac':
        return fetchCaltrainBatacEvents(source);
      case 'eventbrite':
        return fetchEventbriteEvents(source, eventbriteToken);
    }
  };
}
