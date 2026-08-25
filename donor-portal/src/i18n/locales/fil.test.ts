import { describe, it, expect } from 'vitest';
import { fil } from './fil';
import { en } from './en';

describe('fil locale', () => {
  it('has a translation for every English key', () => {
    for (const key of Object.keys(en)) {
      expect(fil[key as keyof typeof en], `missing fil translation for "${key}"`).toBeDefined();
    }
  });

  it('preserves every {{var}} placeholder from the English source', () => {
    for (const [key, enValue] of Object.entries(en)) {
      const placeholders = [...enValue.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[0]);
      const filValue = fil[key as keyof typeof en];
      for (const placeholder of placeholders) {
        expect(filValue, `fil "${key}" is missing ${placeholder}`).toContain(placeholder);
      }
    }
  });
});
