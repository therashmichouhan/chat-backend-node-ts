# Chat Backend

A chat API built with **Node.js + TypeScript (strict)**.

- **PostgreSQL** stores users, chats and chat members.
- **Firebase Firestore** stores messages, read receipts and "last seen" markers.

Supports 1:1 chats, message sending, ordered history, read receipts, last-seen tracking, plus the bonuses: group chats and message edit/delete.

> **First time setting this up?** Follow sections 1 to 7 in order. You do **not** need a Firebase account or a Google Cloud project. Everything runs locally.

---

## Table of contents

1. [What you need](#1-what-you-need)
2. [Install the tools](#2-install-the-tools)
3. [Get the code and install dependencies](#3-get-the-code-and-install-dependencies)
4. [Configure environment variables](#4-configure-environment-variables)
5. [Start Postgres](#5-start-postgres)
6. [Start the Firestore emulator](#6-start-the-firestore-emulator)
7. [Create the tables and run the server](#7-create-the-tables-and-run-the-server)
8. [Try the API](#8-try-the-api)
9. [Run the tests](#9-run-the-tests)
10. [Troubleshooting](#10-troubleshooting)
11. [API reference](#11-api-reference)
12. [Data model and design decisions](#12-data-model-and-design-decisions)
13. [Known limitations](#13-known-limitations)
14. [Project structure](#14-project-structure)

---

## 1. What you need

| Tool | Version | Why | Check it with |
|---|---|---|---|
| Node.js | 20 or newer | runs the server | `node -v` |
| npm | comes with Node | installs packages | `npm -v` |
| Git | any | clone the repo | `git --version` |
| Docker Desktop | any recent | runs Postgres easily (optional, see 5B) | `docker --version` |
| Java (JDK) | **21 or newer** | needed by the Firestore emulator | `java -version` |

You will use **three terminal windows** while running the project: one for Postgres (or none, if it runs in the background), one for the Firestore emulator, and one for the server.

## 2. Install the tools

### Node.js (includes npm)
Download the **LTS** version from https://nodejs.org and run the installer. Reopen your terminal, then run `node -v`. It should print `v20.x` or higher.

### Git
Download from https://git-scm.com/downloads and install with the default options.

### Docker Desktop (easiest way to get Postgres)
Download from https://www.docker.com/products/docker-desktop, install it, and **start the Docker Desktop app** (the whale icon must be running). On Windows it may ask you to enable WSL 2. Accept and restart if prompted. If you prefer not to use Docker, see [5B](#5b-no-docker-install-postgres-directly).

### Java 21+ (for the Firestore emulator)
The emulator is a Java program, so Java must be installed even though this project is Node.

- **Windows:** download "Temurin 21 (LTS)" from https://adoptium.net and install it. Tick the option **"Set JAVA_HOME"** / **"Add to PATH"** if shown.
- **macOS:** `brew install --cask temurin@21` (or download from https://adoptium.net).
- **Linux (Debian/Ubuntu):** `sudo apt install openjdk-21-jre`

Close and reopen your terminal, then run `java -version`. It should show `21` or higher.

## 3. Get the code and install dependencies

```bash
git clone <your-repo-url> chat-backend
cd chat-backend
npm install
```

## 4. Configure environment variables

Copy the example file:

```bash
# macOS / Linux / Git Bash
cp .env.example .env

# Windows PowerShell
copy .env.example .env
```

Open `.env` and set it to this (the defaults match `docker-compose.yml`):

```
PORT=3000
DATABASE_URL=postgres://chat:chat@localhost:5432/chat
FIREBASE_PROJECT_ID=demo-chat
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
```

Notes:
- A project id starting with `demo-` tells Firebase tools this is a local-only project, so **no login or account is needed**.
- `FIRESTORE_EMULATOR_HOST` makes the app talk to the local emulator instead of real Firebase.
- Never commit `.env` (it is already in `.gitignore`).

## 5. Start Postgres

### 5A. With Docker (recommended)

Make sure Docker Desktop is running, then from the project folder:

```bash
docker compose up -d
```

This starts Postgres on port 5432 with user `chat`, password `chat`, database `chat`. Verify with `docker compose ps` (the status should be "running").

Also create a second database for the tests:

```bash
docker compose exec postgres createdb -U chat chat_test
```

To stop it later: `docker compose down` (your data is kept unless you add `-v`).

### 5B. No Docker: install Postgres directly

1. Install PostgreSQL 14 or newer from https://www.postgresql.org/download (remember the password you set for the `postgres` user).
2. Open a SQL shell (`psql -U postgres`) and run:

   ```sql
   CREATE USER chat WITH PASSWORD 'chat' SUPERUSER;
   CREATE DATABASE chat OWNER chat;
   CREATE DATABASE chat_test OWNER chat;
   ```
3. Keep `DATABASE_URL=postgres://chat:chat@localhost:5432/chat` in `.env`.

## 6. Start the Firestore emulator

Open a **new terminal** in the project folder and run:

```bash
npx firebase-tools emulators:start --only firestore --project demo-chat
```

- The first run downloads the emulator (about 60 MB), so it can take a minute. If it asks about usage reporting, answer `n`.
- Leave this terminal open. When ready you will see a table showing Firestore at `127.0.0.1:8080`.
- Note: the command is `firebase-tools`, not `firebase`. The npm package named `firebase` is a different thing.

## 7. Create the tables and run the server

In a **third terminal** in the project folder:

```bash
npm run migrate    # creates the Postgres tables (safe to run again)
npm run dev        # starts the API on http://localhost:3000
```

Check it works by opening http://localhost:3000/health in a browser. You should see `{"ok":true}`.

For a production build instead: `npm run build && npm start`.

## 8. Try the API

You can use curl, or a tool like [Postman](https://www.postman.com/downloads/) / the "Thunder Client" VS Code extension. Every request body is JSON.

### Option A: copy-paste script (macOS / Linux / Git Bash on Windows)

Needs [`jq`](https://jqlang.github.io/jq/download/) installed.

```bash
H='content-type: application/json'
A=$(curl -s -XPOST localhost:3000/users -H "$H" -d '{"name":"Alice"}' | jq -r .id)
B=$(curl -s -XPOST localhost:3000/users -H "$H" -d '{"name":"Bob"}'   | jq -r .id)
C=$(curl -s -XPOST localhost:3000/chat/create -H "$H" -d "{\"userAId\":\"$A\",\"userBId\":\"$B\"}" | jq -r .chatId)
M=$(curl -s -XPOST localhost:3000/chat/$C/message/send -H "$H" -d "{\"senderId\":\"$A\",\"text\":\"hi\"}" | jq -r .id)

curl -s "localhost:3000/chat/$C/messages?userId=$B&limit=50"
curl -s -XPOST localhost:3000/chat/$C/message/$M/read -H "$H" -d "{\"userId\":\"$B\"}"
curl -s -XPOST localhost:3000/chat/$C/lastseen -H "$H" -d "{\"userId\":\"$B\",\"messageId\":\"$M\"}"
curl -s localhost:3000/user/$A/chats
```

### Option B: step by step in Postman (any OS)

1. `POST http://localhost:3000/users` with body `{"name":"Alice"}`. Copy the returned `id` (this is Alice's id). Repeat for Bob.
2. `POST http://localhost:3000/chat/create` with body `{"userAId":"<alice id>","userBId":"<bob id>"}`. Copy `chatId`. Sending it again returns the **same** `chatId`.
3. `POST http://localhost:3000/chat/<chatId>/message/send` with `{"senderId":"<alice id>","text":"hello"}`. Copy the message `id`.
4. `GET http://localhost:3000/chat/<chatId>/messages?userId=<bob id>&limit=50` returns messages oldest to newest.
5. `POST http://localhost:3000/chat/<chatId>/message/<messageId>/read` with `{"userId":"<bob id>"}`.
6. `POST http://localhost:3000/chat/<chatId>/lastseen` with `{"userId":"<bob id>","messageId":"<messageId>"}`.
7. `GET http://localhost:3000/user/<alice id>/chats` lists Alice's chats with member ids.

## 9. Run the tests

```bash
npm run typecheck   # strict TypeScript check of the source and tests
npm test            # API tests (needs Postgres running and the chat_test database from step 5)
```

`npm test` uses a separate `chat_test` database and wipes its tables on every run. It never touches your `chat` data. In these tests Firestore is replaced by an in-memory fake, so the emulator is not required.

To also run the tests that use the **real Firestore logic** (ordering, paging, idempotent read receipts, forward-only last seen, edit/delete), keep the emulator from step 6 running and use:

```bash
# macOS / Linux / Git Bash
RUN_FIRESTORE_TESTS=1 npm test

# Windows PowerShell
$env:RUN_FIRESTORE_TESTS=1; npm test

# Windows cmd
set RUN_FIRESTORE_TESTS=1 && npm test
```

If you used a different Postgres setup, point the tests at it with `TEST_DATABASE_URL`, for example `TEST_DATABASE_URL=postgres://user:pass@localhost:5432/chat_test`.

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| `Missing required env var DATABASE_URL` | You skipped step 4. Create `.env` from `.env.example`. |
| `ECONNREFUSED 127.0.0.1:5432` | Postgres isn't running. Start Docker Desktop, then `docker compose up -d`. |
| `password authentication failed for user "chat"` | The user/password don't match `.env`. Recreate the user (5B) or run `docker compose down -v` then `up -d` again. |
| `database "chat_test" does not exist` | Run the `createdb` command in step 5 for the test database. |
| `Could not spawn java -version` or the emulator asks for Java | Install Java 21+ (step 2), reopen your terminal, check `java -version`. |
| `port 8080 already in use` | Another program uses 8080. Stop it, or change the port in `firebase.json` and `FIRESTORE_EMULATOR_HOST`. |
| Requests hang or fail with Firestore / `UNAVAILABLE` errors | The emulator isn't running, or `FIRESTORE_EMULATOR_HOST` isn't set in `.env`. Restart the server after editing `.env`. |
| `EADDRINUSE :::3000` | Something else uses port 3000. Change `PORT` in `.env`. |
| `docker: command not found` / Docker errors | Docker Desktop isn't installed or isn't running. Start it, or use 5B. |
| `npx firebase ...` does nothing useful | Use `npx firebase-tools ...` (see step 6). |
| Data disappeared after restarting the emulator | Expected. The emulator keeps data in memory only. Postgres data is kept, so just create new chats. |
| Firestore (real project) says a **query requires an index** | Click the link in the error message to create it in one step, or add it to `firestore.indexes.json`. The emulator never needs indexes. |

## 11. API reference

All IDs are UUIDs. Errors: `400` invalid input, `403` not a member / not allowed, `404` not found, `409` already deleted.

| # | Method and path | Body / query | Result |
|---|---|---|---|
| 1 | `POST /chat/create` | `userAId, userBId` | `{ chatId }` (idempotent) |
| 2 | `POST /chat/:chatId/message/send` | `senderId, text` | the stored message |
| 3 | `GET /chat/:chatId/messages?limit=50` | query: `userId`, optional `before=<messageId>` | `{ messages, nextCursor }`, oldest to newest |
| 4 | `POST /chat/:chatId/message/:messageId/read` | `userId` | message including `readBy` |
| 5 | `POST /chat/:chatId/lastseen` | `userId, messageId` | `{ userId, lastSeenMessageId }` |
| 6 | `GET /user/:userId/chats` | none | `{ chats: [{ chatId, type, title, memberIds, createdAt }] }` |
| – | `POST /users` | `name` | helper to create test users |
| – | `GET /health` | none | `{ ok: true }` |
| Bonus | `PATCH /chat/:chatId/message/:messageId` | `userId, text` | edit own message |
| Bonus | `DELETE /chat/:chatId/message/:messageId` | `userId` | soft-delete own message |
| Bonus | `POST /chat/group/create` | `creatorId, title, memberIds[]` | `{ chatId }` |
| Bonus | `POST /chat/:chatId/members` | `actorId, userIds[]` | add members (admins only) |
| Bonus | `DELETE /chat/:chatId/members/:userId` | `actorId` | remove a member, or leave |

Group rules: the creator is the admin. Only admins can add or remove others. Anyone can leave. If the last admin leaves, the longest-standing member becomes admin. An empty group is deleted.

## 12. Data model and design decisions

```
Postgres
  users(id, name, created_at)
  chats(id, type 'direct'|'group', direct_key UNIQUE, title, created_at)
  chat_members(chat_id, user_id, role 'member'|'admin', joined_at)   PK(chat_id, user_id)

Firestore
  chats/{chatId}/messages/{messageId}  { senderId, text, createdAt, editedAt, deleted, readBy: {userId: time} }
  chats/{chatId}/members/{userId}      { lastSeenMessageId, lastSeenAt }
```

- **Split storage as specified.** Membership needs constraints and joins, so it lives in Postgres. Messages are append-heavy and read in time order, which suits Firestore. Postgres is the source of truth for who can access a chat: every endpoint checks it before touching Firestore.
- **One 1:1 chat per pair.** `direct_key` is the two user ids sorted and joined. A `UNIQUE` constraint plus `INSERT ... ON CONFLICT DO NOTHING` keeps this safe under concurrent requests (there is a test for it).
- **Server-side timestamps.** `createdAt` uses Firestore's `serverTimestamp()`, so ordering doesn't depend on client clocks. Document id is the tie-break.
- **Read receipts are a map on the message** (`readBy.{userId}`), so one query returns messages with their receipts. A transaction keeps the first read time, making the endpoint idempotent. Trade-off: for very large groups a per-message subcollection would scale better.
- **Last seen only moves forward.** A transaction compares timestamps, so delayed or out-of-order requests can't move the marker back.
- **Soft delete.** Deleted messages keep their place (text blanked, `deleted: true`), so ordering, cursors and receipts stay consistent.
- **Cursor pagination** (`before=<messageId>`) instead of offsets, which stays stable while new messages arrive.
- **Group changes lock the chat row** (`SELECT ... FOR UPDATE`) to avoid races between concurrent admins.
- **Validation** with zod on every input.

## 13. Known limitations

- **Auth is simplified.** As the task passes `userId` in the request, the API trusts it. In production, derive the user from a verified Firebase ID token and ignore client-supplied ids.
- **Dual write.** Postgres and Firestore can't share a transaction. Membership is checked first and message writes are append-only, so the worst case is an orphaned Firestore message, never a leak to a non-member. Removing a group member keeps their old messages.
- **Chat list order** is by chat creation time. Sorting by last activity would need a `last_message_at` column kept in sync.
- No rate limiting, real-time push (listeners / websockets) or typing indicators.
- **Using real Firebase instead of the emulator:** remove `FIRESTORE_EMULATOR_HOST` from `.env`, set `FIREBASE_PROJECT_ID` to your project, set `GOOGLE_APPLICATION_CREDENTIALS` to the path of a service-account JSON key (never commit it), and deploy `firestore.rules` (deny-all; only this backend uses Firestore).

## 14. Project structure

```
src/
  app.ts            routes, validation, error handling
  chatRepo.ts       Postgres logic: users, direct chats, membership, groups
  messageStore.ts   Firestore logic: messages, read receipts, last seen, edit/delete
  firebase.ts       Firestore setup (auto-detects the emulator)
  db.ts, config.ts  Postgres pool, environment variables
  migrate.ts        applies db/schema.sql
  server.ts         entry point
db/schema.sql       Postgres tables
tests/              API tests (real Postgres, fake Firestore) + Firestore emulator tests
docker-compose.yml  Postgres for local development
firebase.json, firestore.rules, firestore.indexes.json   Firestore emulator / deploy config
```