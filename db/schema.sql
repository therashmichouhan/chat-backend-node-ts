CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL DEFAULT 'direct' CHECK (type IN ('direct', 'group')),
  -- "<smallerUserId>:<largerUserId>" -> guarantees exactly one 1:1 chat per pair
  direct_key  TEXT UNIQUE,
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (type = 'group' OR direct_key IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id   UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
