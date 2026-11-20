export interface StreamEvent {
  streamSeq: string;
  eventId: string | null;
  type: string;
  taskId: string | null;
}

export interface StreamConsume {
  applied: StreamEvent[];
  cursor: string;
  seen: string[];
  remainder: string;
}

export function eventCursorKey(userId: string): string {
  return `superagent.cursor.${userId}`;
}

export function compareSeq(lhs: string, rhs: string): number {
  const normalize = (value: string) => value.replace(/^0+/, '') || '0';
  const left = normalize(lhs);
  const right = normalize(rhs);
  if (left.length !== right.length) return left.length - right.length;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function consumeEventStream(chunk: string, cursor: string, seen: Iterable<string> = [], remainder = ''): StreamConsume {
  const normalized = (remainder + chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const ended = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  let rest = '';
  if (ended) lines.pop();
  else rest = lines.pop() ?? '';
  const seenSet = new Set(seen);
  let nextCursor = cursor;
  const applied: StreamEvent[] = [];
  let id: string | undefined;
  let eventName: string | undefined;
  let data: string[] = [];
  const reset = () => { id = undefined; eventName = undefined; data = []; };
  const dispatch = () => {
    const raw = data.join('\n');
    const currentId = id;
    const currentEvent = eventName;
    reset();
    if (!raw && !currentId && !currentEvent) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    const seqFromBody = typeof record.stream_seq === 'string' && /^\d{1,20}$/.test(record.stream_seq) ? record.stream_seq : null;
    const seqFromId = currentId && /^\d{1,20}$/.test(currentId) ? currentId : null;
    const seq = seqFromBody ?? seqFromId;
    if (!seq) return;
    const eventId = typeof record.event_id === 'string' ? record.event_id : null;
    if (seenSet.has(`seq:${seq}`) || (eventId !== null && seenSet.has(`id:${eventId}`))) return;
    seenSet.add(`seq:${seq}`);
    if (eventId) seenSet.add(`id:${eventId}`);
    if (compareSeq(seq, nextCursor) <= 0) return;
    nextCursor = seq;
    const type = typeof record.type === 'string' ? record.type : currentEvent ?? '';
    const taskId = typeof record.task_id === 'string' && record.task_id ? record.task_id : null;
    applied.push({streamSeq: seq, eventId, type, taskId});
  };
  for (const line of lines) {
    if (line === '') { dispatch(); continue; }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') eventName = value;
    else if (field === 'data') data.push(value);
  }
  let pending = '';
  if (id) pending += `id: ${id}\n`;
  if (eventName) pending += `event: ${eventName}\n`;
  for (const line of data) pending += `data: ${line}\n`;
  return {applied, cursor: nextCursor, seen: [...seenSet], remainder: pending + rest};
}

export function streamFollowUp(events: StreamEvent[]): {taskIds: string[]; reloadDevices: boolean; reloadQuestions: boolean} {
  const taskIds: string[] = [];
  let reloadDevices = false;
  let reloadQuestions = false;
  for (const event of events) {
    if (event.type === 'cursor') continue;
    if (event.taskId && !taskIds.includes(event.taskId)) taskIds.push(event.taskId);
    if (event.type === 'device.changed') reloadDevices = true;
    if (event.type === 'notification.created' || event.type === 'question.created' || event.type === 'question.resolved') reloadQuestions = true;
  }
  return {taskIds, reloadDevices, reloadQuestions};
}

export class EventStreamError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'EventStreamError'; }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish);
  });
}

type ByteReader = {read(): Promise<{done: boolean; value?: Uint8Array}>};

function readerOf(body: unknown): ByteReader | null {
  if (!body || typeof body !== 'object' || !('getReader' in body)) return null;
  const getReader = (body as {getReader?: unknown}).getReader;
  if (typeof getReader !== 'function') return null;
  return (getReader as (this: unknown) => ByteReader).call(body);
}

function linkAbort(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(); return controller.signal; }
    signal.addEventListener('abort', () => controller.abort(), {once: true});
  }
  return controller.signal;
}

export async function readEventStream(input: {
  url: string;
  token: string;
  signal: AbortSignal;
  timeoutMs?: number;
  transport?: typeof fetch;
  onText: (text: string) => void;
}): Promise<void> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), input.timeoutMs ?? 40_000);
  try {
    const response = await (input.transport ?? fetch)(input.url, {
      method: 'GET',
      headers: {Authorization: `Bearer ${input.token}`, Accept: 'text/event-stream'},
      signal: linkAbort([input.signal, timeout.signal]),
    });
    if (!response.ok) throw new EventStreamError(response.status, `事件流连接失败（${response.status}）`);
    const reader = readerOf(response.body);
    if (reader) {
      const decode = new TextDecoder();
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        if (step.value) input.onText(decode.decode(step.value, {stream: true}));
      }
      const tail = decode.decode();
      if (tail) input.onText(tail);
      return;
    }
    input.onText(await response.text());
  } finally {
    clearTimeout(timer);
  }
}
