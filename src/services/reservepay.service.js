// ReservePay Merchant API client. SERVER-SIDE ONLY: it sends the secret API key.
// Docs: https://developer.reservepay.com/guides/accept-payments-using-your-own-ui
const NodeCache = require('node-cache');
const env = require('../config/env');
const { AppError } = require('../utils/errors');
const { activity } = require('./payment-activity.service');

const API_VERSION = '2025-04-01';
const INSTALLATIONS_CACHE_KEY = 'installations';
const installationsCache = new NodeCache({ stdTTL: 300, checkperiod: 120, useClones: true });

const PLATFORM_INSTALLATION_ENV = {
  IOS: 'RESERVEPAY_INSTALLATION_ID_IOS',
  ANDROID: 'RESERVEPAY_INSTALLATION_ID_ANDROID',
};

function isConfigured() {
  return Boolean(env.RESERVEPAY_API_KEY && env.RESERVEPAY_MERCHANT_ID);
}

function installationIdForPlatform(platform) {
  const key = PLATFORM_INSTALLATION_ENV[platform];
  return key ? env[key] || '' : '';
}

async function requestMerchantApi(endpoint, body = {}) {
  if (!isConfigured()) {
    throw new AppError(503, 'Online payment is not configured', 'PAYMENT_NOT_CONFIGURED');
  }
  const response = await fetch(`${env.RESERVEPAY_API_URL}/merchants/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESERVEPAY_API_KEY}`,
      'Api-Version': API_VERSION,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    // Error responses are JSON arrays of error objects, e.g. [{ code: 'INVALID_ARGUMENTS', ... }].
    const first = Array.isArray(json) ? json[0] : json;
    const candidate = typeof first === 'string' ? first : first?.code;
    const code = /^[A-Z0-9_]{1,80}$/.test(String(candidate || '')) ? candidate : `HTTP_${response.status}`;
    const error = new AppError(502, `Payment provider error (${code})`, 'PAYMENT_PROVIDER_ERROR');
    error.providerCode = code;
    // Do not attach provider payloads to errors: the shared error handler logs them.
    throw error;
  }
  return json;
}

async function callMerchantApi(endpoint, body = {}) {
  const started = Date.now();
  await activity('reservepay_provider_request', { code: endpoint });
  try {
    const result = await requestMerchantApi(endpoint, body);
    await activity('reservepay_provider_response', { code: endpoint, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    await activity('reservepay_provider_failure', { code: error.providerCode || 'PROVIDER_UNAVAILABLE', status: 502, durationMs: Date.now() - started });
    throw error;
  }
}

/** Only the fields the app needs; nothing secret leaves the server. */
function toPublicPaymentMethod(method) {
  return {
    name: String(method?.name || ''),
    displayName: String(method?.display_name || method?.name || ''),
    category: String(method?.category || ''),
    flow: String(method?.flow || ''),
  };
}

async function listInstallations({ fresh = false } = {}) {
  if (!fresh) {
    const cached = installationsCache.get(INSTALLATIONS_CACHE_KEY);
    if (cached) return cached;
  }
  const installations = await callMerchantApi('list-installations', {});
  const list = Array.isArray(installations) ? installations : [];
  installationsCache.set(INSTALLATIONS_CACHE_KEY, list);
  return list;
}

/**
 * Payment methods enabled for the app installation on this platform (IOS / ANDROID).
 * Methods are kept only if they are available on that platform.
 */
async function getPlatformPaymentMethods(platform) {
  const installationId = installationIdForPlatform(platform);
  if (!installationId) {
    throw new AppError(503, `No ReservePay installation configured for ${platform}`, 'PAYMENT_NOT_CONFIGURED');
  }
  const installations = await listInstallations();
  const installation = installations.find((item) => item?.installation_id === installationId);
  if (!installation) {
    throw new AppError(503, `ReservePay installation ${installationId} not found`, 'PAYMENT_NOT_CONFIGURED');
  }
  const methods = installation.enabled === false
    ? []
    : (installation.payment_methods || [])
      .filter((method) => !Array.isArray(method?.platforms) || method.platforms.includes(platform))
      .map(toPublicPaymentMethod)
      .filter((method) => method.name);

  return {
    merchantId: env.RESERVEPAY_MERCHANT_ID,
    installationId,
    platform,
    installationEnabled: installation.enabled !== false,
    emailCapture: installation.email_capture || 'disabled',
    mobileCapture: installation.mobile_capture || 'disabled',
    addressCapture: installation.address_capture || 'disabled',
    methods,
  };
}

function initiatePaymentFlow(args) {
  return callMerchantApi('initiate-payment-flow', args);
}

function findPayment(paymentId) {
  return callMerchantApi('find-payment', { payment_id: paymentId });
}

module.exports = {
  API_VERSION,
  isConfigured,
  installationIdForPlatform,
  listInstallations,
  getPlatformPaymentMethods,
  initiatePaymentFlow,
  findPayment,
  toPublicPaymentMethod,
};
