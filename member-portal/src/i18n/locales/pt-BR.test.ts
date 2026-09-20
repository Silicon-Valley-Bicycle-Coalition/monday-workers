import { describe, it, expect } from 'vitest';
import { ptBR } from './pt-BR';
import { en } from './en';

describe('pt-BR locale', () => {
  it('has a translation for every English key', () => {
    for (const key of Object.keys(en)) {
      expect(ptBR[key as keyof typeof en], `missing pt-BR translation for "${key}"`).toBeDefined();
    }
  });

  it('preserves every {{var}} placeholder from the English source', () => {
    for (const [key, enValue] of Object.entries(en)) {
      const placeholders = [...enValue.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[0]);
      const ptBRValue = ptBR[key as keyof typeof en];
      for (const placeholder of placeholders) {
        expect(ptBRValue, `pt-BR "${key}" is missing ${placeholder}`).toContain(placeholder);
      }
    }
  });
});
