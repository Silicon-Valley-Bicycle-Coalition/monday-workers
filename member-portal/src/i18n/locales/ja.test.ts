import { describe, it, expect } from 'vitest';
import { ja } from './ja';
import { en } from './en';

describe('ja locale', () => {
  it('has a translation for every English key', () => {
    for (const key of Object.keys(en)) {
      expect(ja[key as keyof typeof en], `missing ja translation for "${key}"`).toBeDefined();
    }
  });

  it('preserves every {{var}} placeholder from the English source', () => {
    for (const [key, enValue] of Object.entries(en)) {
      const placeholders = [...enValue.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[0]);
      const jaValue = ja[key as keyof typeof en];
      for (const placeholder of placeholders) {
        expect(jaValue, `ja "${key}" is missing ${placeholder}`).toContain(placeholder);
      }
    }
  });
});
