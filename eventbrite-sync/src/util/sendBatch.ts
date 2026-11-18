// Copied from benevity-import/src/util/sendBatch.ts (GL#75): the attendee fan-out sends in batches.
// Cloudflare Queues sendBatch limits: at most 100 messages and 256 KB total per call.
export const MAX_BATCH_MESSAGES = 100;
export const MAX_BATCH_BYTES = 256 * 1024;
// Headroom for per-message framing the platform counts on top of the JSON body.
const PER_MESSAGE_OVERHEAD_BYTES = 128;

const encoder = new TextEncoder();
const sizeOf = (message: unknown): number => encoder.encode(JSON.stringify(message)).byteLength + PER_MESSAGE_OVERHEAD_BYTES;

export function chunkForSendBatch<T>(messages: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const message of messages) {
    const bytes = sizeOf(message);
    if (current.length > 0 && (current.length >= MAX_BATCH_MESSAGES || currentBytes + bytes > MAX_BATCH_BYTES)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(message);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface BatchSender<T> {
  sendBatch(messages: T[]): Promise<void>;
}

export async function sendInBatches<T>(queue: BatchSender<T>, messages: T[]): Promise<void> {
  for (const chunk of chunkForSendBatch(messages)) {
    await queue.sendBatch(chunk);
  }
}
