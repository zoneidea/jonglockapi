const admin = require('firebase-admin');
const env = require('../config/env');

const TEMP_LOCK_COLLECTION = 'booth_temp_locks';
const MAX_DELETE_BATCH_SIZE = 450;

let appInitialized = false;
let initSkippedReason = '';

function parseServiceAccountJson() {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  try {
    return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch {
    initSkippedReason = 'FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON';
    return null;
  }
}

function buildServiceAccount() {
  const jsonAccount = parseServiceAccountJson();
  if (jsonAccount) return jsonAccount;

  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    initSkippedReason = 'Firebase service account is not configured';
    return null;
  }

  return {
    projectId: env.FIREBASE_PROJECT_ID,
    clientEmail: env.FIREBASE_CLIENT_EMAIL,
    privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
}

function getFirestore() {
  if (!appInitialized) {
    const serviceAccount = buildServiceAccount();
    if (!serviceAccount) return null;

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    appInitialized = true;
  }

  return admin.firestore();
}

async function cleanupExpiredBoothTempLocks(nowMs = Date.now()) {
  const db = getFirestore();
  if (!db) {
    return {
      skipped: true,
      deleted: 0,
      reason: initSkippedReason || 'Firebase Admin is not initialized',
    };
  }

  const snapshot = await db
    .collection(TEMP_LOCK_COLLECTION)
    .where('expiresAtMs', '<=', nowMs)
    .limit(MAX_DELETE_BATCH_SIZE)
    .get();

  if (snapshot.empty) {
    return { skipped: false, deleted: 0 };
  }

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  return {
    skipped: false,
    deleted: snapshot.size,
    hasMore: snapshot.size === MAX_DELETE_BATCH_SIZE,
  };
}

module.exports = { cleanupExpiredBoothTempLocks };
