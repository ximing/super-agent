import { ApiError, type Doc, type Tx } from './store.js';
import { publicEvent } from './steps.js';

/** One tenant's durable events after a numeric cursor. Payloads already passed through publicEvent. */
export async function readEvents(tx: Tx, after: unknown): Promise<{ items: Doc[]; cursor: string }> {
  const cursor = String(after ?? '0');
  if (!/^\d{1,20}$/.test(cursor)) throw new ApiError(422, 'invalid_cursor', '事件游标无效');
  const result = await tx.client.query('SELECT data FROM sa_events WHERE tenant_id=$1 AND seq>$2 ORDER BY seq LIMIT 500', [tx.tenant, cursor]);
  const items = result.rows.map(row => {
    const event = publicEvent(row.data ?? {});
    if (event.payload && typeof event.payload === 'object') {
      const version = event.payload.version;
      if (Number.isSafeInteger(version)) event.entity_version = version;
    }
    return event;
  });
  return { items, cursor: items.at(-1)?.stream_seq ?? cursor };
}

export function sseFrame(event: Doc): string {
  const id = String(event.stream_seq ?? '');
  const type = String(event.type ?? 'message').replace(/[^\w.:-]/g, '');
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}
