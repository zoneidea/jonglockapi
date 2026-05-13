const crypto = require('crypto');
const env = require('../config/env');

function getKey() {
  const base64 = Buffer.from(env.FIELD_ENCRYPTION_KEY, 'base64');
  if (base64.length === 32) return base64;

  return crypto.createHash('sha256').update(env.FIELD_ENCRYPTION_KEY).digest();
}

function encryptField(value) {
  if (value === undefined || value === null || value === '') return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function decryptField(payload) {
  if (!payload) return null;

  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function blindIndex(value) {
  if (value === undefined || value === null || value === '') return null;
  return crypto
    .createHmac('sha256', env.FIELD_HASH_SECRET)
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

module.exports = {
  encryptField,
  decryptField,
  blindIndex,
};
