import * as FileSystem from 'expo-file-system/legacy';
import { emptyOutbox, parseOutbox, serializeOutbox, type OutboxFile } from './interaction';
import { storageScope } from './event-stream';

function directory(): string {
  if (!FileSystem.documentDirectory) throw new Error('本地存储不可用');
  return `${FileSystem.documentDirectory}superagent-outbox/`;
}

function fileUri(server: string, userId: string): string {
  return `${directory()}${storageScope(server, userId)}.json`;
}

export async function readOutboxFile(server: string, userId: string): Promise<OutboxFile> {
  const uri = fileUri(server, userId);
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.isDirectory) return emptyOutbox();
  const raw = await FileSystem.readAsStringAsync(uri);
  const parsed = parseOutbox(raw);
  if (!parsed) throw new Error('本地待发送记录无法读取');
  return parsed;
}

/** Message text stays in the app sandbox file. Do not put it in SecureStore. */
export async function writeOutboxFile(server: string, userId: string, file: OutboxFile): Promise<void> {
  const dir = directory();
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const uri = fileUri(server, userId);
  const temporary = `${uri}.tmp`;
  await FileSystem.writeAsStringAsync(temporary, serializeOutbox(file));
  const existing = await FileSystem.getInfoAsync(uri);
  if (existing.exists) await FileSystem.deleteAsync(uri, { idempotent: true });
  await FileSystem.moveAsync({ from: temporary, to: uri });
}
