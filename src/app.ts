import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import * as chats from './chatRepo';
import * as store from './messageStore';
import { HttpError } from './errors';

const id = z.string().uuid();
const text = z.string().trim().min(1).max(4000);
const msgId = z.string().min(1).max(128);

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'Invalid input', r.error.flatten());
  return r.data as z.infer<S>;
}

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Helper so the API can be exercised end-to-end without a separate auth service.
  app.post('/users', handler(async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
    res.status(201).json(await chats.createUser(name));
  }));

  // 1. Create or get chat
  app.post('/chat/create', handler(async (req, res) => {
    const { userAId, userBId } = parse(z.object({ userAId: id, userBId: id }), req.body);
    const chatId = await chats.createOrGetDirectChat(userAId, userBId);
    res.json({ chatId });
  }));

  // 2. Send message
  app.post('/chat/:chatId/message/send', handler(async (req, res) => {
    const { chatId } = parse(z.object({ chatId: id }), req.params);
    const { senderId, text: body } = parse(z.object({ senderId: id, text }), req.body);
    await chats.assertMember(chatId, senderId);
    res.status(201).json(await store.sendMessage(chatId, senderId, body));
  }));

  // 3. Get messages (membership is checked via the `userId` query param)
  app.get('/chat/:chatId/messages', handler(async (req, res) => {
    const { chatId } = parse(z.object({ chatId: id }), req.params);
    const q = parse(
      z.object({
        userId: id,
        limit: z.coerce.number().int().min(1).max(100).default(50),
        before: msgId.optional(),
      }),
      req.query,
    );
    await chats.assertMember(chatId, q.userId);
    res.json(await store.getMessages(chatId, q.limit, q.before));
  }));

  // 4. Mark message read
  app.post('/chat/:chatId/message/:messageId/read', handler(async (req, res) => {
    const { chatId, messageId } = parse(z.object({ chatId: id, messageId: msgId }), req.params);
    const { userId } = parse(z.object({ userId: id }), req.body);
    await chats.assertMember(chatId, userId);
    res.json(await store.markRead(chatId, messageId, userId));
  }));

  // 5. Update last seen message
  app.post('/chat/:chatId/lastseen', handler(async (req, res) => {
    const { chatId } = parse(z.object({ chatId: id }), req.params);
    const { userId, messageId } = parse(z.object({ userId: id, messageId: msgId }), req.body);
    await chats.assertMember(chatId, userId);
    res.json(await store.updateLastSeen(chatId, userId, messageId));
  }));

  // 6. List user chats
  app.get('/user/:userId/chats', handler(async (req, res) => {
    const { userId } = parse(z.object({ userId: id }), req.params);
    res.json({ chats: await chats.listUserChats(userId) });
  }));

  // Bonus: edit / delete message
  app.patch('/chat/:chatId/message/:messageId', handler(async (req, res) => {
    const { chatId, messageId } = parse(z.object({ chatId: id, messageId: msgId }), req.params);
    const { userId, text: body } = parse(z.object({ userId: id, text }), req.body);
    await chats.assertMember(chatId, userId);
    res.json(await store.editMessage(chatId, messageId, userId, body));
  }));

  app.delete('/chat/:chatId/message/:messageId', handler(async (req, res) => {
    const { chatId, messageId } = parse(z.object({ chatId: id, messageId: msgId }), req.params);
    const { userId } = parse(z.object({ userId: id }), req.body);
    await chats.assertMember(chatId, userId);
    res.json(await store.deleteMessage(chatId, messageId, userId));
  }));

  // Bonus: group chats
  app.post('/chat/group/create', handler(async (req, res) => {
    const b = parse(
      z.object({
        creatorId: id,
        title: z.string().trim().min(1).max(100),
        memberIds: z.array(id).min(1).max(255),
      }),
      req.body,
    );
    const chatId = await chats.createGroupChat(b.creatorId, b.title, b.memberIds);
    res.status(201).json({ chatId });
  }));

  app.post('/chat/:chatId/members', handler(async (req, res) => {
    const { chatId } = parse(z.object({ chatId: id }), req.params);
    const b = parse(z.object({ actorId: id, userIds: z.array(id).min(1).max(255) }), req.body);
    res.json({ memberIds: await chats.addGroupMembers(chatId, b.actorId, b.userIds) });
  }));

  app.delete('/chat/:chatId/members/:userId', handler(async (req, res) => {
    const { chatId, userId } = parse(z.object({ chatId: id, userId: id }), req.params);
    const { actorId } = parse(z.object({ actorId: id }), req.body);
    res.json({ memberIds: await chats.removeGroupMember(chatId, actorId, userId) });
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
