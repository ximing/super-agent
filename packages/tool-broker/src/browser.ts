import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Frame } from '@super-agent/protocol';

type RecordValue = Record<string, unknown>;
interface Viewport { width: number; height: number; scale: number; url: string; scroll_x: number; scroll_y: number }
const viewportExpression = 'JSON.stringify({width:innerWidth,height:innerHeight,scale:devicePixelRatio,url:location.href,scroll_x:scrollX,scroll_y:scrollY})';
function parseViewport(result: RecordValue): Viewport | null {
  try {
    const value = (typeof result.value === 'string' ? JSON.parse(result.value) : result.value) as Viewport;
    if (!(value.width > 0 && value.height > 0 && Number.isFinite(value.width) && Number.isFinite(value.height))) return null;
    return { width: value.width, height: value.height, scale: Number(value.scale) || 1, url: String(value.url ?? ''), scroll_x: Number(value.scroll_x) || 0, scroll_y: Number(value.scroll_y) || 0 };
  } catch { return null; }
}
/** Parse encoded screenshot dimensions without introducing an image processing runtime. */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}
/** CSI has mutable per-session current tabs and OS focus: serialize all operations. */
export class BrowserActor {
  private queue: Promise<unknown> = Promise.resolve();
  private owner: string | null = null;
  private human = false;
  private generation = 0;
  private viewports = new Map<string, Viewport>();
  private recentFrames = new Map<string, { frame: Frame; viewport: Viewport | null }>();
  constructor(private readonly endpoint = 'http://127.0.0.1:10088', private readonly fetcher: typeof fetch = fetch) {}
  acquire(runId: string): void {
    if (this.owner && this.owner !== runId) throw new Error('browser_busy: another run owns the browser');
    this.owner = runId;
  }
  async release(runId: string): Promise<void> {
    await this.queue.catch(() => undefined);
    if (this.owner === runId) { this.owner = null; this.human = false; }
  }
  setHuman(runId: string, enabled: boolean): void { this.acquire(runId); this.human = enabled; }
  private serial<T>(runId: string, human: boolean, operation: () => Promise<T>): Promise<T> {
    const execute = async () => {
      this.acquire(runId);
      if (this.human !== human) throw new Error(this.human ? 'human_control_active' : 'human_control_not_active');
      return operation();
    };
    const next = this.queue.then(execute, execute);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async request(runId: string, action: string, args: RecordValue = {}): Promise<RecordValue> {
    const response = await this.fetcher(`${this.endpoint}/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, args, session: `super-agent-${runId}` }),
      signal: AbortSignal.timeout(35_000),
    });
    if (!response.ok) throw new Error(`CSI HTTP ${response.status}`);
    const result = await response.json() as { success: boolean; error?: string; data?: RecordValue };
    if (!result.success) throw new Error(`CSI: ${result.error ?? 'operation failed'}`);
    return result.data ?? {};
  }
  async observe(runId: string): Promise<{ url: string; captured_at: string }> {
    return this.serial(runId, false, async () => {
      const metadata = await this.request(runId, 'evaluate', { code: viewportExpression });
      const viewport = parseViewport(metadata);
      if (viewport) this.viewports.set(runId, viewport);
      return { url: viewport?.url ?? '', captured_at: new Date().toISOString() };
    });
  }
  async call(runId: string, action: string, args: RecordValue = {}): Promise<RecordValue> {
    return this.serial(runId, false, async () => {
      const result = await this.request(runId, action, args);
      if (['navigate', 'click', 'fill', 'mouse_click', 'send_keys', 'key_type'].includes(action)) this.generation++;
      return result;
    });
  }
  async frame(runId: string): Promise<Frame> {
    // A read frame is permitted while human has control, but still serialized with input.
    const operation = async () => {
      const temporaryOwner = this.owner === null;
      this.acquire(runId);
      try {
      const data = await this.request(runId, 'screenshot', { format: 'jpeg', quality: 65 });
      if (typeof data.path !== 'string') throw new Error('CSI did not return screenshot path');
      const bytes = await readFile(data.path);
      if (bytes.length > 3 * 1024 * 1024) throw new Error('frame_too_large');
      const metadata = await this.request(runId, 'evaluate', { code: viewportExpression });
      const viewport = parseViewport(metadata), dimensions = imageSize(bytes);
      if (viewport) {
        const prior = this.viewports.get(runId);
        if (prior && JSON.stringify(prior) !== JSON.stringify(viewport)) this.generation++;
        this.viewports.set(runId, viewport);
      }
      const frame: Frame = { frame_id: randomUUID(), image_base64: bytes.toString('base64'), width: dimensions?.width ?? viewport?.width ?? 1280, height: dimensions?.height ?? viewport?.height ?? 800,
        captured_at: new Date().toISOString(), viewport_version: String(this.generation), tab_id: null };
      this.recentFrames.set(`${runId}:${frame.frame_id}`, { frame, viewport: dimensions ? viewport : null });
      for (const [key, entry] of this.recentFrames) if (Date.now() - Date.parse(entry.frame.captured_at) > 15_000 || this.recentFrames.size > 256) this.recentFrames.delete(key);
      return frame;
      } finally { if (temporaryOwner && !this.human && this.owner === runId) this.owner = null; }
    };
    const next = this.queue.then(operation, operation); this.queue = next.catch(() => undefined); return next;
  }
  async input(runId: string, input: RecordValue): Promise<void> {
    await this.serial(runId, true, async () => {
      const captured = this.recentFrames.get(`${runId}:${String(input.frame_id)}`), frame = captured?.frame;
      if (!frame || frame.viewport_version !== input.viewport_version || frame.viewport_version !== String(this.generation) || Date.now() - Date.parse(frame.captured_at) > 15_000)
        throw new Error('stale_frame: refresh the browser image before controlling it');
      const viewport = captured?.viewport;
      if (!viewport) throw new Error('viewport_unavailable: refresh before controlling');
      const currentViewport = parseViewport(await this.request(runId, 'evaluate', { code: viewportExpression }));
      if (!currentViewport || JSON.stringify(currentViewport) !== JSON.stringify(viewport)) throw new Error('stale_viewport: refresh before controlling');
      switch (input.type) {
        case 'click': {
          const imageX = Number(input.x), imageY = Number(input.y);
          if (!Number.isFinite(imageX) || !Number.isFinite(imageY) || imageX < 0 || imageY < 0 || imageX >= frame.width || imageY >= frame.height) throw new Error('invalid_coordinates');
          const x = imageX * viewport.width / frame.width, y = imageY * viewport.height / frame.height;
          await this.request(runId, 'cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } });
          await this.request(runId, 'cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } });
          break;
        }
        case 'text':
        case 'type': await this.request(runId, 'key_type', { text: String(input.text ?? '') }); break;
        case 'keys': await this.request(runId, 'send_keys', { keys: String(input.keys ?? '') }); break;
        case 'scroll': await this.request(runId, 'cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 1, y: 1, deltaX: Number(input.x ?? 0) * viewport.width / frame.width, deltaY: Number(input.y ?? 0) * viewport.height / frame.height } }); break;
        default: throw new Error('unsupported_input');
      }
      this.generation++;
    });
  }
}
