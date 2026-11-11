import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/messageStore', async () => await import('./fakeStore'));

import { createApp } from '../src/app';
import { pool } from '../src/db';
import { reset } from './fakeStore';

const app = createApp();
const api = () => request(app);

async function newUser(name: string): Promise<string> {
  const res = await api().post('/users').send({ name }).expect(201);
  return res.body.id as string;
}
async function directChat(a: string, b: string): Promise<string> {
  const res = await api().post('/chat/create').send({ userAId: a, userBId: b }).expect(200);
  return res.body.chatId as string;
}
async function send(chatId: string, senderId: string, text: string) {
  return (await api().post(`/chat/${chatId}/message/send`).send({ senderId, text }).expect(201)).body;
}

let alice: string, bob: string, carol: string;

beforeAll(async () => {
  await pool.query(readFileSync(join(process.cwd(), 'db', 'schema.sql'), 'utf8'));
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE users, chats, chat_members CASCADE');
  reset();
  [alice, bob, carol] = [await newUser('Alice'), await newUser('Bob'), await newUser('Carol')];
});

describe('POST /chat/create', () => {
  it('is idempotent and symmetric', async () => {
    const c1 = await directChat(alice, bob);
    const c2 = await directChat(bob, alice);
    expect(c2).toBe(c1);
  });

  it('returns one chat even under concurrent requests', async () => {
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) => directChat(i % 2 ? alice : bob, i % 2 ? bob : alice)),
    );
    expect(new Set(ids).size).toBe(1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM chats');
    expect(rows[0].n).toBe(1);
  });

  it('rejects self-chat, unknown users and malformed ids', async () => {
    await api().post('/chat/create').send({ userAId: alice, userBId: alice }).expect(400);
    await api()
      .post('/chat/create')
      .send({ userAId: alice, userBId: '00000000-0000-4000-8000-000000000000' })
      .expect(404);
    await api().post('/chat/create').send({ userAId: 'nope', userBId: bob }).expect(400);
  });
});

describe('messages', () => {
  it('only members can send or read', async () => {
    const chat = await directChat(alice, bob);
    await api().post(`/chat/${chat}/message/send`).send({ senderId: carol, text: 'hi' }).expect(403);
    await api().get(`/chat/${chat}/messages`).query({ userId: carol }).expect(403);
    await api()
      .post('/chat/00000000-0000-4000-8000-000000000000/message/send')
      .send({ senderId: alice, text: 'hi' })
      .expect(404);
  });

  it('rejects empty / whitespace text', async () => {
    const chat = await directChat(alice, bob);
    await api().post(`/chat/${chat}/message/send`).send({ senderId: alice, text: '   ' }).expect(400);
  });

  it('returns messages oldest -> newest, honours limit and pages with `before`', async () => {
    const chat = await directChat(alice, bob);
    for (let i = 1; i <= 5; i++) await send(chat, i % 2 ? alice : bob, `msg ${i}`);

    const all = await api().get(`/chat/${chat}/messages`).query({ userId: alice }).expect(200);
    expect(all.body.messages.map((m: { text: string }) => m.text)).toEqual([
      'msg 1', 'msg 2', 'msg 3', 'msg 4', 'msg 5',
    ]);

    const page1 = await api().get(`/chat/${chat}/messages`).query({ userId: alice, limit: 2 }).expect(200);
    expect(page1.body.messages.map((m: { text: string }) => m.text)).toEqual(['msg 4', 'msg 5']);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await api()
      .get(`/chat/${chat}/messages`)
      .query({ userId: alice, limit: 2, before: page1.body.nextCursor })
      .expect(200);
    expect(page2.body.messages.map((m: { text: string }) => m.text)).toEqual(['msg 2', 'msg 3']);
  });

  it('validates limit', async () => {
    const chat = await directChat(alice, bob);
    await api().get(`/chat/${chat}/messages`).query({ userId: alice, limit: 0 }).expect(400);
    await api().get(`/chat/${chat}/messages`).query({ userId: alice, limit: 1000 }).expect(400);
  });
});

describe('read receipts & last seen', () => {
  it('records a read once; sender cannot read own message', async () => {
    const chat = await directChat(alice, bob);
    const m = await send(chat, alice, 'hello');

    const r1 = await api().post(`/chat/${chat}/message/${m.id}/read`).send({ userId: bob }).expect(200);
    const r2 = await api().post(`/chat/${chat}/message/${m.id}/read`).send({ userId: bob }).expect(200);
    expect(r1.body.readBy[bob]).toBeDefined();
    expect(r2.body.readBy[bob]).toBe(r1.body.readBy[bob]); // first read time wins

    await api().post(`/chat/${chat}/message/${m.id}/read`).send({ userId: alice }).expect(400);
    await api().post(`/chat/${chat}/message/nope/read`).send({ userId: bob }).expect(404);
    await api().post(`/chat/${chat}/message/${m.id}/read`).send({ userId: carol }).expect(403);
  });

  it('last seen moves forward only', async () => {
    const chat = await directChat(alice, bob);
    const m1 = await send(chat, alice, '1');
    const m2 = await send(chat, alice, '2');

    await api().post(`/chat/${chat}/lastseen`).send({ userId: bob, messageId: m2.id }).expect(200);
    const res = await api().post(`/chat/${chat}/lastseen`).send({ userId: bob, messageId: m1.id }).expect(200);
    expect(res.body.lastSeenMessageId).toBe(m2.id);
    await api().post(`/chat/${chat}/lastseen`).send({ userId: bob, messageId: 'nope' }).expect(404);
  });
});

describe('GET /user/:userId/chats', () => {
  it('lists chats with member ids and 404s for unknown users', async () => {
    const ab = await directChat(alice, bob);
    await directChat(alice, carol);

    const res = await api().get(`/user/${alice}/chats`).expect(200);
    expect(res.body.chats).toHaveLength(2);
    const chat = res.body.chats.find((c: { chatId: string }) => c.chatId === ab);
    expect([...chat.memberIds].sort()).toEqual([alice, bob].sort());

    const bobChats = await api().get(`/user/${bob}/chats`).expect(200);
    expect(bobChats.body.chats).toHaveLength(1);

    await api().get('/user/00000000-0000-4000-8000-000000000000/chats').expect(404);
  });
});

describe('edit / delete', () => {
  it('only the sender can edit or delete; delete is soft', async () => {
    const chat = await directChat(alice, bob);
    const m = await send(chat, alice, 'original');

    await api().patch(`/chat/${chat}/message/${m.id}`).send({ userId: bob, text: 'x' }).expect(403);
    const edited = await api().patch(`/chat/${chat}/message/${m.id}`).send({ userId: alice, text: 'edited' }).expect(200);
    expect(edited.body.text).toBe('edited');
    expect(edited.body.editedAt).not.toBeNull();

    await api().delete(`/chat/${chat}/message/${m.id}`).send({ userId: bob }).expect(403);
    const del = await api().delete(`/chat/${chat}/message/${m.id}`).send({ userId: alice }).expect(200);
    expect(del.body).toMatchObject({ deleted: true, text: '' });

    await api().patch(`/chat/${chat}/message/${m.id}`).send({ userId: alice, text: 'again' }).expect(409);
    const list = await api().get(`/chat/${chat}/messages`).query({ userId: bob }).expect(200);
    expect(list.body.messages).toHaveLength(1); // still there, so ordering/cursors stay intact
  });
});

describe('group chats', () => {
  async function group(): Promise<string> {
    const res = await api()
      .post('/chat/group/create')
      .send({ creatorId: alice, title: 'Team', memberIds: [bob] })
      .expect(201);
    return res.body.chatId as string;
  }

  it('creates a group with the creator as admin and lists it for members', async () => {
    const chat = await group();
    const res = await api().get(`/user/${bob}/chats`).expect(200);
    expect(res.body.chats[0]).toMatchObject({ chatId: chat, type: 'group', title: 'Team' });
    const { rows } = await pool.query("SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chat, alice]);
    expect(rows[0].role).toBe('admin');

    await send(chat, bob, 'group message works'); // group chats share the messaging path
  });

  it('rejects a group with no other members', async () => {
    await api()
      .post('/chat/group/create')
      .send({ creatorId: alice, title: 'Solo', memberIds: [alice] })
      .expect(400);
  });

  it('only admins add/remove others; members can leave', async () => {
    const chat = await group();
    await api().post(`/chat/${chat}/members`).send({ actorId: bob, userIds: [carol] }).expect(403);
    const added = await api().post(`/chat/${chat}/members`).send({ actorId: alice, userIds: [carol, carol] }).expect(200);
    expect(added.body.memberIds).toHaveLength(3);

    await api().delete(`/chat/${chat}/members/${carol}`).send({ actorId: bob }).expect(403);
    await api().delete(`/chat/${chat}/members/${bob}`).send({ actorId: bob }).expect(200); // leave
    const removed = await api().delete(`/chat/${chat}/members/${carol}`).send({ actorId: alice }).expect(200);
    expect(removed.body.memberIds).toEqual([alice]);

    // removed users lose access
    await api().post(`/chat/${chat}/message/send`).send({ senderId: bob, text: 'hi' }).expect(403);
  });

  it('promotes a member when the last admin leaves; deletes an empty group', async () => {
    const chat = await group();
    await api().delete(`/chat/${chat}/members/${alice}`).send({ actorId: alice }).expect(200);
    const { rows } = await pool.query("SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chat, bob]);
    expect(rows[0].role).toBe('admin');

    await api().delete(`/chat/${chat}/members/${bob}`).send({ actorId: bob }).expect(200);
    const gone = await pool.query('SELECT 1 FROM chats WHERE id=$1', [chat]);
    expect(gone.rowCount).toBe(0);
  });

  it('refuses to manage members of a direct chat', async () => {
    const chat = await directChat(alice, bob);
    await api().post(`/chat/${chat}/members`).send({ actorId: alice, userIds: [carol] }).expect(400);
  });
});
