import {
  DocumentReference,
  DocumentSnapshot,
  FieldPath,
  FieldValue,
  Timestamp,
  Transaction,
} from 'firebase-admin/firestore';
import { firestore } from './firebase';
import { HttpError } from './errors';

/*
 * Firestore layout
 *   chats/{chatId}/messages/{messageId}
 *       { senderId, text, createdAt, editedAt?, deleted, readBy: { [userId]: Timestamp } }
 *   chats/{chatId}/members/{userId}
 *       { lastSeenMessageId, lastSeenAt }
 */

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  text: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  readBy: Record<string, string>;
}

const chatDoc = (chatId: string) => firestore.collection('chats').doc(chatId);
const messagesCol = (chatId: string) => chatDoc(chatId).collection('messages');
const memberDoc = (chatId: string, userId: string) =>
  chatDoc(chatId).collection('members').doc(userId);

function toMessage(chatId: string, snap: DocumentSnapshot): Message {
  const d = snap.data();
  if (!d) throw new HttpError(404, 'Message not found');
  const readBy: Record<string, string> = {};
  for (const [uid, ts] of Object.entries((d.readBy ?? {}) as Record<string, Timestamp>)) {
    readBy[uid] = ts.toDate().toISOString();
  }
  const deleted = Boolean(d.deleted);
  return {
    id: snap.id,
    chatId,
    senderId: d.senderId as string,
    text: deleted ? '' : (d.text as string),
    createdAt: (d.createdAt as Timestamp).toDate().toISOString(),
    editedAt: d.editedAt ? (d.editedAt as Timestamp).toDate().toISOString() : null,
    deleted,
    readBy,
  };
}

export async function sendMessage(chatId: string, senderId: string, text: string): Promise<Message> {
  const ref = messagesCol(chatId).doc();
  await ref.set({
    senderId,
    text,
    createdAt: FieldValue.serverTimestamp(), // server-side time => consistent ordering across clients
    editedAt: null,
    deleted: false,
    readBy: {},
  });
  return toMessage(chatId, await ref.get());
}

/** Returns up to `limit` most recent messages, oldest -> newest. Use `before` (a message id) to page back. */
export async function getMessages(
  chatId: string,
  limit: number,
  before?: string,
): Promise<{ messages: Message[]; nextCursor: string | null }> {
  let q = messagesCol(chatId)
    .orderBy('createdAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc')
    .limit(limit);

  if (before) {
    const cursor = await messagesCol(chatId).doc(before).get();
    if (!cursor.exists) throw new HttpError(400, 'Invalid "before" cursor');
    q = q.startAfter(cursor);
  }

  const snap = await q.get();
  const messages = snap.docs.map((d) => toMessage(chatId, d)).reverse();
  const last = snap.docs[snap.docs.length - 1];
  const nextCursor = snap.size === limit && last ? last.id : null;
  return { messages, nextCursor };
}

/** Idempotent: the first read time wins; the sender can't "read" their own message. */
export async function markRead(chatId: string, messageId: string, userId: string): Promise<Message> {
  const ref = messagesCol(chatId).doc(messageId);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'Message not found');
    const data = snap.data()!;
    if (data.senderId === userId) throw new HttpError(400, 'Cannot mark your own message as read');
    if ((data.readBy ?? {})[userId]) return;
    tx.update(ref, new FieldPath('readBy', userId), FieldValue.serverTimestamp());
  });
  return toMessage(chatId, await ref.get());
}

/** Last-seen only moves forward in time, so late/out-of-order requests can't regress it. */
export async function updateLastSeen(
  chatId: string,
  userId: string,
  messageId: string,
): Promise<{ userId: string; lastSeenMessageId: string }> {
  const msgRef = messagesCol(chatId).doc(messageId);
  const memRef = memberDoc(chatId, userId);

  return firestore.runTransaction(async (tx) => {
    const [msg, mem] = await Promise.all([tx.get(msgRef), tx.get(memRef)]);
    if (!msg.exists) throw new HttpError(404, 'Message not found');

    const currentId = mem.data()?.lastSeenMessageId as string | undefined;
    if (currentId && currentId !== messageId) {
      const current = await tx.get(messagesCol(chatId).doc(currentId));
      const curTs = current.data()?.createdAt as Timestamp | undefined;
      const newTs = msg.data()!.createdAt as Timestamp;
      if (curTs && curTs.toMillis() > newTs.toMillis()) {
        return { userId, lastSeenMessageId: currentId };
      }
    }
    tx.set(memRef, { lastSeenMessageId: messageId, lastSeenAt: FieldValue.serverTimestamp() }, { merge: true });
    return { userId, lastSeenMessageId: messageId };
  });
}

async function mutateOwnMessage(
  chatId: string,
  messageId: string,
  userId: string,
  apply: (tx: Transaction, ref: DocumentReference) => void,
): Promise<Message> {
  const ref = messagesCol(chatId).doc(messageId);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'Message not found');
    const d = snap.data()!;
    if (d.senderId !== userId) throw new HttpError(403, 'Only the sender can modify this message');
    if (d.deleted) throw new HttpError(409, 'Message already deleted');
    apply(tx, ref);
  });
  return toMessage(chatId, await ref.get());
}

export function editMessage(chatId: string, messageId: string, userId: string, text: string): Promise<Message> {
  return mutateOwnMessage(chatId, messageId, userId, (tx, ref) =>
    tx.update(ref, { text, editedAt: FieldValue.serverTimestamp() }),
  );
}

/** Soft delete so ordering, read receipts and cursors stay intact. */
export function deleteMessage(chatId: string, messageId: string, userId: string): Promise<Message> {
  return mutateOwnMessage(chatId, messageId, userId, (tx, ref) =>
    tx.update(ref, { deleted: true, text: '', editedAt: FieldValue.serverTimestamp() }),
  );
}
