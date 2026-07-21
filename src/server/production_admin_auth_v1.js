import {
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { putJSONOnlyIfNew } from './blob_repository_v1.js';
import {
  ADMIN_SESSION_TTL_SECONDS,
  AdminAuthError,
  normalizeAdminUsername,
  verifyAdminCredentials,
} from './admin_auth_v1.js';
import {
  ProductionRuntimeConfigError,
  readProductionRuntimeConfig,
} from './production_runtime_config_v1.js';

export const PRODUCTION_ADMIN_AUTH_CONFIG_VERSION = 1;
export const PRODUCTION_ADMIN_ISSUER = 'cloud-collab-admin-production';
export const PRODUCTION_ADMIN_LOGIN_RATE_SLOT_MS = 10_000;
export const PRODUCTION_ADMIN_LOGIN_RATE_PREFIX = 'admin-production-rate/login';

const TOKEN_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const JWT_HEADER = Object.freeze({ alg: 'HS256', typ: 'JWT' });
const JWT_PAYLOAD_KEYS = Object.freeze(['aud', 'exp', 'iat', 'iss', 'jti', 'sub', 'v']);

function wrapRuntimeError(error) {
  if (error instanceof ProductionRuntimeConfigError) {
    return new AdminAuthError(error.code, error.message, 503, error.details, error);
  }
  return error;
}

export function readProductionAdminAuthConfig(env = {}) {
  let runtime;
  try {
    runtime = readProductionRuntimeConfig(env);
  } catch (error) {
    throw wrapRuntimeError(error);
  }
  if (runtime.mode !== 'production'
      || runtime.flags.production !== true
      || runtime.flags.admin !== true) {
    throw new AdminAuthError('PRODUCTION_ADMIN_AUTH_DISABLED', '正式管理员身份能力未开启', 503);
  }
  const username = normalizeAdminUsername(runtime.adminUsername);
  if (username !== 'xiaxue') {
    throw new AdminAuthError('PRODUCTION_ADMIN_USERNAME_INVALID', '正式管理员用户名必须为xiaxue', 503);
  }
  return Object.freeze({
    schemaVersion: PRODUCTION_ADMIN_AUTH_CONFIG_VERSION,
    mode: 'production',
    username,
    password: runtime.secrets.CLOUD_ADMIN_PASSWORD,
    sessionSecret: runtime.secrets.CLOUD_ADMIN_SESSION_SECRET,
    rateLimitSalt: runtime.secrets.CLOUD_ADMIN_RATE_LIMIT_SALT,
    storeName: runtime.adminStoreName,
    publicOrigin: runtime.adminOrigin,
    sessionTtlSeconds: ADMIN_SESSION_TTL_SECONDS,
    issuer: PRODUCTION_ADMIN_ISSUER,
    ratePrefix: PRODUCTION_ADMIN_LOGIN_RATE_PREFIX,
    externalScope: runtime.scope.external,
    protocolScope: runtime.scope.protocol,
    stablePromotionAuthorized: false,
  });
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function parseBase64UrlJson(segment, label) {
  if (!TOKEN_SEGMENT_PATTERN.test(segment) || segment.length > 2048) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', `${label}无效`, 401);
  }
  let bytes;
  try {
    bytes = Buffer.from(segment, 'base64url');
  } catch (_) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', `${label}无效`, 401);
  }
  if (bytes.length === 0 || bytes.length > 1024 || bytes.toString('base64url') !== segment) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', `${label}无效`, 401);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', `${label}无效`, 401);
  }
}

function signTokenInput(input, secret) {
  return createHmac('sha256', Buffer.from(String(secret || ''), 'utf8'))
    .update(input, 'utf8')
    .digest();
}

export function createProductionAdminSessionToken({
  config,
  now = Date.now(),
  randomBytes = nodeRandomBytes,
} = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new AdminAuthError('ADMIN_SESSION_TIME_INVALID', '管理员会话时间无效', 500);
  }
  if (config?.issuer !== PRODUCTION_ADMIN_ISSUER || config?.mode !== 'production') {
    throw new AdminAuthError('PRODUCTION_ADMIN_SESSION_CONFIG_INVALID', '正式管理员会话配置无效', 503);
  }
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + config.sessionTtlSeconds;
  const nonce = randomBytes(16);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 16) {
    throw new AdminAuthError('ADMIN_SESSION_NONCE_FAILED', '管理员会话随机数生成失败', 500);
  }
  const payload = {
    v: 1,
    iss: config.issuer,
    aud: config.issuer,
    sub: config.username,
    iat: issuedAt,
    exp: expiresAt,
    jti: nonce.toString('base64url'),
  };
  const signingInput = `${base64UrlJson(JWT_HEADER)}.${base64UrlJson(payload)}`;
  const signature = signTokenInput(signingInput, config.sessionSecret).toString('base64url');
  return Object.freeze({
    token: `${signingInput}.${signature}`,
    expiresAt: expiresAt * 1000,
  });
}

export function verifyProductionAdminSessionToken(token, config, { now = Date.now() } = {}) {
  const value = String(token || '');
  if (value.length < 64 || value.length > 4096) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', '管理员会话无效', 401);
  }
  if (config?.issuer !== PRODUCTION_ADMIN_ISSUER || config?.mode !== 'production') {
    throw new AdminAuthError('PRODUCTION_ADMIN_SESSION_CONFIG_INVALID', '正式管理员会话配置无效', 503);
  }
  const parts = value.split('.');
  if (parts.length !== 3) throw new AdminAuthError('ADMIN_SESSION_INVALID', '管理员会话无效', 401);
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = parseBase64UrlJson(headerSegment, '管理员会话头');
  const payload = parseBase64UrlJson(payloadSegment, '管理员会话载荷');
  if (JSON.stringify(header) !== JSON.stringify(JWT_HEADER)) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', '管理员会话算法无效', 401);
  }
  if (!TOKEN_SEGMENT_PATTERN.test(signatureSegment) || signatureSegment.length > 128) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', '管理员会话签名无效', 401);
  }
  let suppliedSignature;
  try {
    suppliedSignature = Buffer.from(signatureSegment, 'base64url');
  } catch (_) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', '管理员会话签名无效', 401);
  }
  const expectedSignature = signTokenInput(`${headerSegment}.${payloadSegment}`, config.sessionSecret);
  if (suppliedSignature.length !== expectedSignature.length
      || !timingSafeEqual(suppliedSignature, expectedSignature)) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', '管理员会话签名无效', 401);
  }
  const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload).sort()
    : [];
  if (JSON.stringify(keys) !== JSON.stringify([...JWT_PAYLOAD_KEYS])) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', '管理员会话字段无效', 401);
  }
  const nowSeconds = Math.floor(now / 1000);
  const claimsValid = payload.v === 1
    && payload.iss === config.issuer
    && payload.aud === config.issuer
    && payload.sub === config.username
    && Number.isSafeInteger(payload.iat)
    && Number.isSafeInteger(payload.exp)
    && payload.exp - payload.iat === config.sessionTtlSeconds
    && payload.iat <= nowSeconds + 30
    && payload.iat >= nowSeconds - config.sessionTtlSeconds - 30
    && typeof payload.jti === 'string'
    && /^[A-Za-z0-9_-]{22}$/.test(payload.jti);
  if (!claimsValid) throw new AdminAuthError('ADMIN_SESSION_INVALID', '管理员会话声明无效', 401);
  if (payload.exp <= nowSeconds) throw new AdminAuthError('ADMIN_SESSION_EXPIRED', '管理员会话已过期', 401);
  return Object.freeze({
    username: payload.sub,
    issuedAt: payload.iat * 1000,
    expiresAt: payload.exp * 1000,
    sessionIdSuffix: payload.jti.slice(-4),
  });
}

function normalizeRateSubject(value, fallback) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text.length > 160 || /[\u0000-\u001f\u007f]/.test(text)) return fallback;
  return text;
}

export function productionAdminLoginRateKey({
  username,
  clientAddress,
  salt,
  now = Date.now(),
} = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new AdminAuthError('ADMIN_RATE_TIME_INVALID', '管理员登录限流时间无效', 500);
  }
  const normalizedUsername = normalizeRateSubject(username, 'invalid-username');
  const normalizedAddress = normalizeRateSubject(clientAddress, 'unknown-client');
  const subjectHash = createHmac('sha256', Buffer.from(String(salt || ''), 'utf8'))
    .update(`${normalizedUsername}\u0000${normalizedAddress}`, 'utf8')
    .digest('base64url');
  const slot = Math.floor(now / PRODUCTION_ADMIN_LOGIN_RATE_SLOT_MS);
  return `${PRODUCTION_ADMIN_LOGIN_RATE_PREFIX}/${subjectHash}/${slot}.json`;
}

export async function consumeProductionAdminLoginRate({
  store,
  username,
  clientAddress,
  salt,
  now = Date.now(),
} = {}) {
  const key = productionAdminLoginRateKey({ username, clientAddress, salt, now });
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((PRODUCTION_ADMIN_LOGIN_RATE_SLOT_MS - (now % PRODUCTION_ADMIN_LOGIN_RATE_SLOT_MS)) / 1000),
  );
  try {
    await putJSONOnlyIfNew(store, key, Object.freeze({
      schemaVersion: 1,
      mode: 'production',
      slot: Math.floor(now / PRODUCTION_ADMIN_LOGIN_RATE_SLOT_MS),
      createdAt: now,
    }));
    return Object.freeze({ allowed: true, key, retryAfterSeconds: 0 });
  } catch (error) {
    if (error?.code === 'BLOB_ALREADY_EXISTS') {
      throw new AdminAuthError(
        'ADMIN_LOGIN_RATE_LIMITED',
        '管理员登录尝试过于频繁',
        429,
        { retryAfterSeconds },
        error,
      );
    }
    throw new AdminAuthError('ADMIN_RATE_LIMIT_FAILED', '管理员登录限流暂时不可用', 503, null, error);
  }
}

export { verifyAdminCredentials };
