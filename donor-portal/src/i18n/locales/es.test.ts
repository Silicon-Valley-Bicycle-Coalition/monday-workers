import { describe, it, expect } from 'vitest';
import { es } from './es';
import { en } from './en';

describe('es locale', () => {
  it('has a translation for every English key', () => {
    for (const key of Object.keys(en)) {
      expect(es[key as keyof typeof en], `missing es translation for "${key}"`).toBeDefined();
    }
  });

  it('preserves every {{var}} placeholder from the English source', () => {
    for (const [key, enValue] of Object.entries(en)) {
      const placeholders = [...enValue.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[0]);
      const esValue = es[key as keyof typeof en];
      for (const placeholder of placeholders) {
        expect(esValue, `es "${key}" is missing ${placeholder}`).toContain(placeholder);
      }
    }
  });
});
