import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false, // tests share one Postgres database
    testTimeout: 20_000,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://chat:chat@localhost:5432/chat_test',
      FIREBASE_PROJECT_ID: 'chat-test',
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080',
    },
  },
});
