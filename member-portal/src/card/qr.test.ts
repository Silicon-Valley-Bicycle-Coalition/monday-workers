import { describe, it, expect } from 'vitest';
import { generateQrSvg } from './qr';

describe('generateQrSvg', () => {
  it('returns an inline SVG for the given text', () => {
    const svg = generateQrSvg('https://portal.example.org/verify/abc123');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('produces different output for different input text', () => {
    const a = generateQrSvg('https://portal.example.org/verify/token-a');
    const b = generateQrSvg('https://portal.example.org/verify/token-b');
    expect(a).not.toBe(b);
  });

  it('recolors the module path gold and the background dark, not the library default black-on-white', () => {
    const svg = generateQrSvg('https://portal.example.org/verify/abc123');
    expect(svg).toContain('fill="#FFC20E"');
    expect(svg).toContain('fill="#171415"');
    expect(svg).not.toContain('fill="black"');
    expect(svg).not.toContain('fill="white"');
  });
});
