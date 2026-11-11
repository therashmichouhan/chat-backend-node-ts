import { config } from './config';
import { createApp } from './app';
import { pool } from './db';

const server = createApp().listen(config.port, () => {
  console.log(`Chat backend listening on :${config.port}`);
});

function shutdown(): void {
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
