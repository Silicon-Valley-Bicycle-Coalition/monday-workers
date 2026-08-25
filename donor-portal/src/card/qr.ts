import qrcode from 'qrcode-generator';

export function generateQrSvg(text: string): string {
  const qr = qrcode(0, 'M'); // typeNumber 0 = auto-detect the smallest size that fits the data
  qr.addData(text);
  qr.make();
  // margin is in the same pixel units as cellSize, and the QR spec mandates a 4-module quiet
  // zone around the code for reliable scanning — so this must stay cellSize * 4 (16), not a
  // smaller arbitrary-looking number, even though a too-small margin will often still scan by
  // accident in a plain unstyled page.
  return qr.createSvgTag({ cellSize: 4, margin: 16 });
}
