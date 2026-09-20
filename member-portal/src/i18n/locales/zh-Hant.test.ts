import { describe, it, expect } from 'vitest';
import { zhHant } from './zh-Hant';
import { en } from './en';

describe('zh-Hant locale', () => {
  it('has a translation for every English key', () => {
    for (const key of Object.keys(en)) {
      expect(zhHant[key as keyof typeof en], `missing zh-Hant translation for "${key}"`).toBeDefined();
    }
  });

  it('preserves every {{var}} placeholder from the English source', () => {
    for (const [key, enValue] of Object.entries(en)) {
      const placeholders = [...enValue.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[0]);
      const zhHantValue = zhHant[key as keyof typeof en];
      for (const placeholder of placeholders) {
        expect(zhHantValue, `zh-Hant "${key}" is missing ${placeholder}`).toContain(placeholder);
      }
    }
  });
});
