const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { AppError } = require('./errors');

const ACTIVE_STATES = ['creating', 'pending', 'unknown', 'review'];

function minorUnits(amount) {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(amount));
  if (!match) throw new AppError(400, 'Invalid money amount', 'PAYMENT_AMOUNT_MISMATCH');
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
}

function requestHash({ bookingIds, paymentSessionId, amount }) {
  return createHash('sha256').update(JSON.stringify({
    bookingIds: [...bookingIds].sort((a, b) => a - b), paymentSessionId, amount, currency: 'THB',
  })).digest('hex');
}

function verifySignature(rawBody, header, verificationKey) {
  if (!Buffer.isBuffer(rawBody) || !verificationKey || !/^[A-Za-z0-9+/]+={0,2}$/.test(verificationKey)) return false;
  const match = /^hmac_sha256=([a-fA-F0-9]{64})$/.exec(String(header || ''));
  if (!match) return false;
  const key = Buffer.from(verificationKey, 'base64');
  if (!key.length) return false;
  const expected = createHmac('sha256', key).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(match[1], 'hex'));
}

function unixDate(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function publicAttempt(row, bookingIds) {
  return {
    attemptId: row.public_id,
    paymentId: row.provider_reference || null,
    paymentSessionId: row.payment_session_id,
    paymentMethod: row.payment_method || null,
    status: row.state,
    providerStatus: row.provider_status || null,
    amount: String(row.amount_minor),
    currency: row.currency,
    ...(bookingIds ? { bookingIds } : {}),
    updatedAt: row.updated_at,
  };
}

module.exports = { ACTIVE_STATES, minorUnits, requestHash, verifySignature, unixDate, publicAttempt };
