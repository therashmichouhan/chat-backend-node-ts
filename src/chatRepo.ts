import { pool } from './db';
import { HttpError } from './errors';

export interface UserRow { id: string; name: string; createdAt: string }
export interface ChatSummary {
  chatId: string;
  type: 'direct' | 'group';
  title: string | null;
  memberIds: string[];
  createdAt: string;
}

export async function createUser(name: string): Promise<UserRow> {
  const { rows } = await pool.query<{ id: string; name: string; created_at: Date }>(
    'INSERT INTO users (name) VALUES ($1) RETURNING id, name, created_at',
    [name],
  );
  const r = rows[0]!;
  return { id: r.id, name: r.name, createdAt: r.created_at.toISOString() };
}

/** Idempotent: returns the existing 1:1 chat for the pair, or creates it. */
export async function createOrGetDirectChat(userAId: string, userBId: string): Promise<string> {
  if (userAId === userBId) throw new HttpError(400, 'userAId and userBId must differ');

  const { rows: users } = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE id = ANY($1::uuid[])',
    [[userAId, userBId]],
  );
  if (users.length !== 2) throw new HttpError(404, 'One or both users not found');

  const directKey = [userAId, userBId].sort().join(':');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query<{ id: string }>(
      `INSERT INTO chats (type, direct_key) VALUES ('direct', $1)
       ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
      [directKey],
    );
    let chatId: string;
    const created = ins.rows[0];
    if (created) {
      chatId = created.id;
      await client.query(
        'INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)',
        [chatId, userAId, userBId],
      );
    } else {
      // Lost the race or chat already existed; the winner's row is visible now.
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM chats WHERE direct_key = $1',
        [directKey],
      );
      chatId = existing.rows[0]!.id;
    }
    await client.query('COMMIT');
    return chatId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** 404 if the chat doesn't exist, 403 if the user isn't a member. */
export async function assertMember(chatId: string, userId: string): Promise<void> {
  const { rows } = await pool.query<{ user_id: string | null }>(
    `SELECT m.user_id FROM chats c
     LEFT JOIN chat_members m ON m.chat_id = c.id AND m.user_id = $2
     WHERE c.id = $1`,
    [chatId, userId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Chat not found');
  if (!row.user_id) throw new HttpError(403, 'User is not a member of this chat');
}

export async function listUserChats(userId: string): Promise<ChatSummary[]> {
  const { rows: u } = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (u.length === 0) throw new HttpError(404, 'User not found');

  const { rows } = await pool.query<{
    id: string; type: 'direct' | 'group'; title: string | null;
    created_at: Date; member_ids: string[];
  }>(
    `SELECT c.id, c.type, c.title, c.created_at,
            array_agg(m2.user_id::text ORDER BY m2.joined_at, m2.user_id) AS member_ids
     FROM chat_members m1
     JOIN chats c ON c.id = m1.chat_id
     JOIN chat_members m2 ON m2.chat_id = c.id
     WHERE m1.user_id = $1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    chatId: r.id,
    type: r.type,
    title: r.title,
    memberIds: r.member_ids,
    createdAt: r.created_at.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/* Group chats                                                         */
/* ------------------------------------------------------------------ */

async function assertUsersExist(userIds: string[]): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE id = ANY($1::uuid[])',
    [userIds],
  );
  if (rows.length !== userIds.length) throw new HttpError(404, 'One or more users not found');
}

/** Creator becomes admin. Needs at least one other member. */
export async function createGroupChat(
  creatorId: string,
  title: string,
  memberIds: string[],
): Promise<string> {
  const others = [...new Set(memberIds)].filter((m) => m !== creatorId);
  if (others.length === 0) throw new HttpError(400, 'A group needs at least one other member');
  await assertUsersExist([creatorId, ...others]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO chats (type, title) VALUES ('group', $1) RETURNING id`,
      [title],
    );
    const chatId = rows[0]!.id;
    await client.query(
      `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [chatId, creatorId],
    );
    await client.query(
      `INSERT INTO chat_members (chat_id, user_id)
       SELECT $1, u FROM unnest($2::uuid[]) AS u`,
      [chatId, others],
    );
    await client.query('COMMIT');
    return chatId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function lockGroupAndRole(
  client: { query: typeof pool.query },
  chatId: string,
  actorId: string,
): Promise<'admin' | 'member'> {
  const chat = await client.query<{ type: string }>(
    'SELECT type FROM chats WHERE id = $1 FOR UPDATE',
    [chatId],
  );
  const c = chat.rows[0];
  if (!c) throw new HttpError(404, 'Chat not found');
  if (c.type !== 'group') throw new HttpError(400, 'Not a group chat');
  const m = await client.query<{ role: 'admin' | 'member' }>(
    'SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2',
    [chatId, actorId],
  );
  const row = m.rows[0];
  if (!row) throw new HttpError(403, 'User is not a member of this chat');
  return row.role;
}

export async function addGroupMembers(
  chatId: string,
  actorId: string,
  userIds: string[],
): Promise<string[]> {
  const ids = [...new Set(userIds)];
  await assertUsersExist(ids);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await lockGroupAndRole(client, chatId, actorId);
    if (role !== 'admin') throw new HttpError(403, 'Only admins can add members');
    await client.query(
      `INSERT INTO chat_members (chat_id, user_id)
       SELECT $1, u FROM unnest($2::uuid[]) AS u
       ON CONFLICT DO NOTHING`,
      [chatId, ids],
    );
    const { rows } = await client.query<{ user_id: string }>(
      'SELECT user_id::text FROM chat_members WHERE chat_id = $1 ORDER BY joined_at, user_id',
      [chatId],
    );
    await client.query('COMMIT');
    return rows.map((r) => r.user_id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Admins can remove anyone; members can only remove themselves (leave).
 * If the last admin leaves, the longest-standing member is promoted;
 * if nobody is left, the chat row is deleted.
 */
export async function removeGroupMember(
  chatId: string,
  actorId: string,
  targetId: string,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await lockGroupAndRole(client, chatId, actorId);
    if (actorId !== targetId && role !== 'admin') {
      throw new HttpError(403, 'Only admins can remove other members');
    }
    const del = await client.query(
      'DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, targetId],
    );
    if (del.rowCount === 0) throw new HttpError(404, 'Target user is not a member');

    const { rows } = await client.query<{ user_id: string; role: string }>(
      'SELECT user_id::text, role FROM chat_members WHERE chat_id = $1 ORDER BY joined_at, user_id',
      [chatId],
    );
    if (rows.length === 0) {
      await client.query('DELETE FROM chats WHERE id = $1', [chatId]);
    } else if (!rows.some((r) => r.role === 'admin')) {
      await client.query(
        `UPDATE chat_members SET role = 'admin' WHERE chat_id = $1 AND user_id = $2::uuid`,
        [chatId, rows[0]!.user_id],
      );
    }
    await client.query('COMMIT');
    return rows.map((r) => r.user_id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
