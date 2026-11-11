import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  firebaseProjectId: required('FIREBASE_PROJECT_ID'),
  usingEmulator: Boolean(process.env.FIRESTORE_EMULATOR_HOST),
} as const;
