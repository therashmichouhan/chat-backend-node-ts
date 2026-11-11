import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config';

const app =
  getApps()[0] ??
  initializeApp({
    projectId: config.firebaseProjectId,
    // The emulator needs no credentials; the Admin SDK detects FIRESTORE_EMULATOR_HOST itself.
    ...(config.usingEmulator ? {} : { credential: applicationDefault() }),
  });

export const firestore = getFirestore(app);
