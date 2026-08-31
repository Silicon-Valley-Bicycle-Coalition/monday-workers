import { describe, it, expect } from 'vitest';
import { zhHans } from './zh-Hans';
import { en } from './en';

describe('zh-Hans locale', () => {
  it('has a translation for every English key', () => {
    for (const key of Object.keys(en)) {
      expect(zhHans[key as keyof typeof en], `missing zh-Hans translation for "${key}"`).toBeDefined();
    }
  });

  it('preserves every {{var}} placeholder from the English source', () => {
    for (const [key, enValue] of Object.entries(en)) {
      const placeholders = [...enValue.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[0]);
      const zhHansValue = zhHans[key as keyof typeof en];
      for (const placeholder of placeholders) {
        expect(zhHansValue, `zh-Hans "${key}" is missing ${placeholder}`).toContain(placeholder);
      }
    }
  });
});
