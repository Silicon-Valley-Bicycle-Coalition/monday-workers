import qrcode from 'qrcode-generator';

export function generateQrSvg(text: string): string {
  const qr = qrcode(0, 'M'); // typeNumber 0 = auto-detect the smallest size that fits the data
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2 });
}
