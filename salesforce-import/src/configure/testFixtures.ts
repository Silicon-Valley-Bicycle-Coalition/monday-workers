import type { CurrentColumn } from './plan.js';

export const COLS: CurrentColumn[] = [
  { id: 'name', title: 'Name', type: 'name', description: null, settings_str: '{}' },
  { id: 'em', title: 'Personal Email', type: 'email', description: null, settings_str: '{}' },
  { id: 'lg', title: 'Lifetime Giving', type: 'numbers', description: null, settings_str: '{}' },
  { id: 'dl', title: 'Donor Level', type: 'status', description: null, settings_str: '{"labels":{"0":"Leadership","1":"Major","2":"Donor"}}' },
  { id: 'dbg', title: 'Salesforce Debug', type: 'long_text', description: null, settings_str: '{}' },
];
