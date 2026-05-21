const env = require('../config/env');

const TEMP_LOCK_COLLECTION = 'booth_temp_locks';
const MAX_DELETE_BATCH_SIZE = 450;

let admin = null;
let appInitialized = false;
let initSkippedReason = '';

function getFirebaseAdmin() {
  if (admin) return admin;
  try {
    // Keep firebase-admin optional so the core API can start on shared hosting
    // even before npm install has run for this dependency.
    admin = require('firebase-admin');
    return admin;
  } catch {
    initSkippedReason = 'firebase-admin module is not installed';
    return null;
  }
}

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
  const firebaseAdmin = getFirebaseAdmin();
  if (!firebaseAdmin) return null;

  if (!appInitialized) {
    const serviceAccount = buildServiceAccount();
    if (!serviceAccount) return null;

    if (!firebaseAdmin.apps.length) {
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(serviceAccount),
      });
    }
    appInitialized = true;
  }

  return firebaseAdmin.firestore();
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
