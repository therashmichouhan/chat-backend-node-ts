/**
 * Exercises the real Firestore logic (ordering, read receipts, last seen, edit/delete).
 * Needs the Firestore emulator:
 *   npx firebase emulators:start --only firestore --project chat-test
 *   RUN_FIRESTORE_TESTS=1 npm test
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as store from '../src/messageStore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!process.env.RUN_FIRESTORE_TESTS)('messageStore (Firestore emulator)', () => {
  const alice = randomUUID();
  const bob = randomUUID();

  async function seed(chatId: string, n: number) {
    const out = [];
    for (let i = 1; i <= n; i++) {
      out.push(await store.sendMessage(chatId, alice, `msg ${i}`));
      await sleep(10);
    }
    return out;
  }

  it('orders by timestamp, limits and pages backwards', async () => {
    const chatId = randomUUID();
    await seed(chatId, 5);

    const all = await store.getMessages(chatId, 50);
    expect(all.messages.map((m) => m.text)).toEqual(['msg 1', 'msg 2', 'msg 3', 'msg 4', 'msg 5']);

    const p1 = await store.getMessages(chatId, 2);
    expect(p1.messages.map((m) => m.text)).toEqual(['msg 4', 'msg 5']);
    const p2 = await store.getMessages(chatId, 2, p1.nextCursor!);
    expect(p2.messages.map((m) => m.text)).toEqual(['msg 2', 'msg 3']);
  });

  it('markRead is idempotent and keeps the first read time', async () => {
    const chatId = randomUUID();
    const [m] = await seed(chatId, 1);
    const r1 = await store.markRead(chatId, m!.id, bob);
    await sleep(20);
    const r2 = await store.markRead(chatId, m!.id, bob);
    expect(r2.readBy[bob]).toBe(r1.readBy[bob]);
    await expect(store.markRead(chatId, m!.id, alice)).rejects.toMatchObject({ status: 400 });
    await expect(store.markRead(chatId, 'missing', bob)).rejects.toMatchObject({ status: 404 });
  });

  it('last seen never moves backwards', async () => {
    const chatId = randomUUID();
    const [m1, m2] = await seed(chatId, 2);
    await store.updateLastSeen(chatId, bob, m2!.id);
    const res = await store.updateLastSeen(chatId, bob, m1!.id);
    expect(res.lastSeenMessageId).toBe(m2!.id);
  });

  it('edit and soft-delete respect ownership', async () => {
    const chatId = randomUUID();
    const [m] = await seed(chatId, 1);
    await expect(store.editMessage(chatId, m!.id, bob, 'x')).rejects.toMatchObject({ status: 403 });
    const edited = await store.editMessage(chatId, m!.id, alice, 'edited');
    expect(edited.text).toBe('edited');
    const del = await store.deleteMessage(chatId, m!.id, alice);
    expect(del).toMatchObject({ deleted: true, text: '' });
    await expect(store.deleteMessage(chatId, m!.id, alice)).rejects.toMatchObject({ status: 409 });
  });
});
