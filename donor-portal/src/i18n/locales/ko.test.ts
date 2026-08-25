import { describe, it, expect } from 'vitest';
import { ko } from './ko';
import { en } from './en';

describe('ko locale', () => {
  it('has a translation for every English key', () => {
    for (const key of Object.keys(en)) {
      expect(ko[key as keyof typeof en], `missing ko translation for "${key}"`).toBeDefined();
    }
  });

  it('preserves every {{var}} placeholder from the English source', () => {
    for (const [key, enValue] of Object.entries(en)) {
      const placeholders = [...enValue.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[0]);
      const koValue = ko[key as keyof typeof en];
      for (const placeholder of placeholders) {
        expect(koValue, `ko "${key}" is missing ${placeholder}`).toContain(placeholder);
      }
    }
  });
});
