/**
 * In-memory stand-in for src/messageStore.ts, used by the API tests so they only
 * need Postgres. It mirrors the real module's contract and error codes.
 * The real Firestore logic is covered by messageStore.emulator.test.ts.
 */
import { HttpError } from '../src/errors';
import type { Message } from '../src/messageStore';

const messages = new Map<string, Message[]>(); // chatId -> ordered list
const lastSeen = new Map<string, string>(); // `${chatId}:${userId}` -> messageId
let clock = 0;
let seq = 0;

export function reset(): void {
  messages.clear();
  lastSeen.clear();
}

const iso = (n: number): string => new Date(1_700_000_000_000 + n).toISOString();

function find(chatId: string, messageId: string): Message {
  const m = messages.get(chatId)?.find((x) => x.id === messageId);
  if (!m) throw new HttpError(404, 'Message not found');
  return m;
}

export async function sendMessage(chatId: string, senderId: string, text: string): Promise<Message> {
  const m: Message = {
    id: `m${String(++seq).padStart(6, '0')}`,
    chatId,
    senderId,
    text,
    createdAt: iso(++clock),
    editedAt: null,
    deleted: false,
    readBy: {},
  };
  messages.set(chatId, [...(messages.get(chatId) ?? []), m]);
  return m;
}

export async function getMessages(chatId: string, limit: number, before?: string) {
  let list = messages.get(chatId) ?? [];
  if (before) {
    const idx = list.findIndex((m) => m.id === before);
    if (idx < 0) throw new HttpError(400, 'Invalid "before" cursor');
    list = list.slice(0, idx);
  }
  const page = list.slice(-limit);
  return {
    messages: page,
    nextCursor: page.length === limit && list.length > limit ? page[0]!.id : null,
  };
}

export async function markRead(chatId: string, messageId: string, userId: string): Promise<Message> {
  const m = find(chatId, messageId);
  if (m.senderId === userId) throw new HttpError(400, 'Cannot mark your own message as read');
  m.readBy[userId] ??= iso(++clock);
  return m;
}

export async function updateLastSeen(chatId: string, userId: string, messageId: string) {
  find(chatId, messageId);
  const key = `${chatId}:${userId}`;
  const cur = lastSeen.get(key);
  if (!cur || cur <= messageId) lastSeen.set(key, messageId); // ids are monotonic here
  return { userId, lastSeenMessageId: lastSeen.get(key)! };
}

function own(chatId: string, messageId: string, userId: string): Message {
  const m = find(chatId, messageId);
  if (m.senderId !== userId) throw new HttpError(403, 'Only the sender can modify this message');
  if (m.deleted) throw new HttpError(409, 'Message already deleted');
  return m;
}

export async function editMessage(chatId: string, messageId: string, userId: string, text: string) {
  const m = own(chatId, messageId, userId);
  m.text = text;
  m.editedAt = iso(++clock);
  return m;
}

export async function deleteMessage(chatId: string, messageId: string, userId: string) {
  const m = own(chatId, messageId, userId);
  m.deleted = true;
  m.text = '';
  m.editedAt = iso(++clock);
  return m;
}
