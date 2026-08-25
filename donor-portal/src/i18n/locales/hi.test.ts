import { describe, it, expect } from 'vitest';
import { hi } from './hi';
import { en } from './en';

describe('hi locale', () => {
  it('has a translation for every English key', () => {
    for (const key of Object.keys(en)) {
      expect(hi[key as keyof typeof en], `missing hi translation for "${key}"`).toBeDefined();
    }
  });

  it('preserves every {{var}} placeholder from the English source', () => {
    for (const [key, enValue] of Object.entries(en)) {
      const placeholders = [...enValue.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[0]);
      const hiValue = hi[key as keyof typeof en];
      for (const placeholder of placeholders) {
        expect(hiValue, `hi "${key}" is missing ${placeholder}`).toContain(placeholder);
      }
    }
  });
});
