const env = require('../config/env');

let admin = null;
let appInitialized = false;
let initSkippedReason = '';

function getFirebaseAdmin() {
  if (admin) return admin;
  try {
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

function ensureFirebaseApp() {
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

  return firebaseAdmin;
}

function getFirebaseAuth() {
  const firebaseAdmin = ensureFirebaseApp();
  if (!firebaseAdmin) return null;
  return firebaseAdmin.auth();
}

function getFirebaseInitReason() {
  return initSkippedReason || 'Firebase Admin is not initialized';
}

module.exports = {
  getFirebaseAuth,
  getFirebaseInitReason,
};
