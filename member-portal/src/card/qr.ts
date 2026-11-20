import qrcode from 'qrcode-generator';

// Brand gold on the membership card's own dark card-face color, so the QR reads as part of the
// card rather than a pasted-in black-on-white sticker. #FFC20E (svbc-gold) on #171415 is 11.3:1 luminance
// contrast (WCAG AAA is 7:1), well within what phone cameras scan reliably.
const QR_MODULE_COLOR = '#FFC20E';
const QR_BACKGROUND_COLOR = '#171415';

export function generateQrSvg(text: string): string {
  const qr = qrcode(0, 'M'); // typeNumber 0 = auto-detect the smallest size that fits the data
  qr.addData(text);
  qr.make();
  // margin is in the same pixel units as cellSize, and the QR spec mandates a 4-module quiet
  // zone around the code for reliable scanning — so this must stay cellSize * 4 (16), not a
  // smaller arbitrary-looking number, even though a too-small margin will often still scan by
  // accident in a plain unstyled page.
  const svg = qr.createSvgTag({ cellSize: 4, margin: 16 });
  // createSvgTag has no color option — it always emits a white background rect and a black
  // module path, each exactly once, so a plain (non-global) replace is safe regardless of QR size.
  return svg.replace('fill="white"', `fill="${QR_BACKGROUND_COLOR}"`).replace('fill="black"', `fill="${QR_MODULE_COLOR}"`);
}
