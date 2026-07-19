import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { putJSONOnlyIfNew } from './blob_repository_v1.js';

export const ADMIN_AUTH_CONFIG_VERSION = 1;
export const ADMIN_SESSION_COOKIE_NAME = 'cloud_admin_session';
export const ADMIN_SESSION_TTL_SECONDS = 15 * 60;
export const ADMIN_LOGIN_RATE_SLOT_MS = 10_000;
export const ADMIN_PREVIEW_STORE_NAME = 'cloud-collab-admin-preview-v1';

const ADMIN_ISSUER = 'cloud-collab-admin-preview';
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._@+-]{2,63}$/;
const TOKEN_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const JWT_HEADER = Object.freeze({ alg: 'HS256', typ: 'JWT' });
const JWT_PAYLOAD_KEYS = Object.freeze(['aud', 'exp', 'iat', 'iss', 'jti', 'sub', 'v']);

export class AdminAuthError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '管理员身份验证失败');
    this.name = 'AdminAuthError';
    this.code = code || 'ADMIN_AUTH_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function secretByteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function assertSecret(value, code, label) {
  const bytes = secretByteLength(value);
  if (bytes < 32 || bytes > 256) {
    throw new AdminAuthError(code, `${label}必须为32至256字节`, 503);
  }
  return String(value);
}

export function normalizeAdminUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new AdminAuthError('ADMIN_USERNAME_NOT_CONFIGURED', '管理员用户名配置无效', 503);
  }
  return username;
}

export function readAdminAuthConfig(env = {}) {
  if (String(env.CLOUD_ADMIN_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new AdminAuthError('ADMIN_PREVIEW_DISABLED', '管理员预览登录未开启', 503);
  }
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '0').trim() === '1'
      || String(env.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED || '0').trim() === '1') {
    throw new AdminAuthError(
      'ADMIN_PREVIEW_REQUIRES_PUBLIC_PREVIEW_DISABLED',
      '管理员预览登录不能与公共写入或自动审核预览同时开启',
      503,
    );
  }

  const username = normalizeAdminUsername(env.CLOUD_ADMIN_USERNAME);
  const password = String(env.CLOUD_ADMIN_PASSWORD || '');
  const passwordBytes = secretByteLength(password);
  if (passwordBytes < 16 || passwordBytes > 256) {
    throw new AdminAuthError('ADMIN_PASSWORD_NOT_CONFIGURED', '管理员密码必须为16至256字节', 503);
  }
  const sessionSecret = assertSecret(
    env.CLOUD_ADMIN_SESSION_SECRET,
    'ADMIN_SESSION_SECRET_NOT_CONFIGURED',
    '管理员会话密钥',
  );
  const rateLimitSalt = assertSecret(
    env.CLOUD_ADMIN_RATE_LIMIT_SALT,
    'ADMIN_RATE_LIMIT_SALT_NOT_CONFIGURED',
    '管理员限流盐值',
  );
  if (new Set([password, sessionSecret, rateLimitSalt]).size !== 3) {
    throw new AdminAuthError('ADMIN_SECRETS_MUST_BE_DISTINCT', '管理员密码、会话密钥和限流盐值不得复用', 503);
  }

  const storeName = String(env.CLOUD_ADMIN_BLOB_STORE_NAME || '').trim();
  if (storeName !== ADMIN_PREVIEW_STORE_NAME) {
    throw new AdminAuthError('ADMIN_STORE_MISCONFIGURED', '管理员预览限流必须使用独立Blob命名空间', 503);
  }

  return Object.freeze({
    schemaVersion: ADMIN_AUTH_CONFIG_VERSION,
    username,
    password,
    sessionSecret,
    rateLimitSalt,
    storeName,
    sessionTtlSeconds: ADMIN_SESSION_TTL_SECONDS,
  });
}

function fixedDigest(value) {
  return createHash('sha256').update(Buffer.from(String(value || ''), 'utf8')).digest();
}

function safeValueEqual(left, right) {
  return timingSafeEqual(fixedDigest(left), fixedDigest(right));
}

export function verifyAdminCredentials(config, input = {}) {
  let suppliedUsername = '';
  try {
    suppliedUsername = normalizeAdminUsername(input.username);
  } catch (_) {
    suppliedUsername = 'invalid-admin-username';
  }
  const suppliedPassword = String(input.password || '');
  const usernameMatches = safeValueEqual(config?.username, suppliedUsername);
  const passwordMatches = safeValueEqual(config?.password, suppliedPassword);
  return usernameMatches && passwordMatches;
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
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(input, 'utf8').digest();
}

export function createAdminSessionToken({
  config,
  now = Date.now(),
  randomBytes = nodeRandomBytes,
} = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new AdminAuthError('ADMIN_SESSION_TIME_INVALID', '管理员会话时间无效', 500);
  }
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + ADMIN_SESSION_TTL_SECONDS;
  const nonce = randomBytes(16);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 16) {
    throw new AdminAuthError('ADMIN_SESSION_NONCE_FAILED', '管理员会话随机数生成失败', 500);
  }
  const payload = {
    v: 1,
    iss: ADMIN_ISSUER,
    aud: ADMIN_ISSUER,
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

export function verifyAdminSessionToken(token, config, { now = Date.now() } = {}) {
  const value = String(token || '');
  if (value.length < 64 || value.length > 4096) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', '管理员会话无效', 401);
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
    && payload.iss === ADMIN_ISSUER
    && payload.aud === ADMIN_ISSUER
    && payload.sub === config.username
    && Number.isSafeInteger(payload.iat)
    && Number.isSafeInteger(payload.exp)
    && payload.exp - payload.iat === ADMIN_SESSION_TTL_SECONDS
    && payload.iat <= nowSeconds + 30
    && payload.iat >= nowSeconds - ADMIN_SESSION_TTL_SECONDS - 30
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

export function createAdminSessionCookie(token) {
  const value = String(token || '');
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value.length > 4096) {
    throw new AdminAuthError('ADMIN_SESSION_INVALID', '管理员会话Cookie无效', 500);
  }
  return `${ADMIN_SESSION_COOKIE_NAME}=${value}; Path=/api/admin; Max-Age=${ADMIN_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearAdminSessionCookie() {
  return `${ADMIN_SESSION_COOKIE_NAME}=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function readAdminSessionCookie(request) {
  const header = String(request?.headers?.get?.('cookie') || '');
  if (!header || header.length > 8192) {
    throw new AdminAuthError('ADMIN_SESSION_MISSING', '管理员会话不存在', 401);
  }
  const values = [];
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (name === ADMIN_SESSION_COOKIE_NAME) values.push(part.slice(index + 1).trim());
  }
  if (values.length !== 1 || !values[0]) {
    throw new AdminAuthError('ADMIN_SESSION_MISSING', '管理员会话不存在', 401);
  }
  return values[0];
}

function normalizeRateSubject(value, fallback) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text.length > 160 || /[\u0000-\u001f\u007f]/.test(text)) return fallback;
  return text;
}

export function adminClientAddress(request) {
  const headers = request?.headers;
  const direct = headers?.get?.('cf-connecting-ip') || headers?.get?.('x-real-ip') || '';
  const forwarded = String(headers?.get?.('x-forwarded-for') || '').split(',')[0];
  return normalizeRateSubject(direct || forwarded, 'unknown-client');
}

export function adminLoginRateKey({ username, clientAddress, salt, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new AdminAuthError('ADMIN_RATE_TIME_INVALID', '管理员登录限流时间无效', 500);
  }
  const normalizedUsername = normalizeRateSubject(username, 'invalid-username');
  const normalizedAddress = normalizeRateSubject(clientAddress, 'unknown-client');
  const subjectHash = createHmac('sha256', Buffer.from(String(salt || ''), 'utf8'))
    .update(`${normalizedUsername}\u0000${normalizedAddress}`, 'utf8')
    .digest('base64url');
  const slot = Math.floor(now / ADMIN_LOGIN_RATE_SLOT_MS);
  return `admin-preview-rate/login/${subjectHash}/${slot}.json`;
}

export async function consumeAdminLoginRate({ store, username, clientAddress, salt, now = Date.now() } = {}) {
  const key = adminLoginRateKey({ username, clientAddress, salt, now });
  const retryAfterSeconds = Math.max(1, Math.ceil((ADMIN_LOGIN_RATE_SLOT_MS - (now % ADMIN_LOGIN_RATE_SLOT_MS)) / 1000));
  try {
    await putJSONOnlyIfNew(store, key, Object.freeze({
      schemaVersion: 1,
      slot: Math.floor(now / ADMIN_LOGIN_RATE_SLOT_MS),
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

export function assertAdminSameOriginRequest(request, { requireOrigin = false } = {}) {
  let url;
  try {
    url = new URL(request?.url || '');
  } catch (_) {
    throw new AdminAuthError('ADMIN_REQUEST_ORIGIN_INVALID', '管理员请求地址无效', 403);
  }
  const forwardedProto = String(request?.headers?.get?.('x-forwarded-proto') || '').trim().toLowerCase();
  const forwardedProtocolIsSecure = forwardedProto === 'https' || forwardedProto === 'quic';
  const forwardedProtocolIsValid = !forwardedProto
    || forwardedProtocolIsSecure
    || forwardedProto === 'http';
  const directProtocolIsSecure = url.protocol === 'https:';
  const trustedProxyHttps = url.protocol === 'http:' && forwardedProtocolIsSecure;
  if (!forwardedProtocolIsValid
      || (!directProtocolIsSecure && !trustedProxyHttps)
      || (directProtocolIsSecure && forwardedProto === 'http')) {
    throw new AdminAuthError('ADMIN_HTTPS_REQUIRED', '管理员接口只允许HTTPS', 403);
  }
  const publicOrigin = `https://${url.host}`;
  const origin = String(request?.headers?.get?.('origin') || '');
  if ((requireOrigin && !origin) || (origin && origin !== publicOrigin)) {
    throw new AdminAuthError('ADMIN_REQUEST_ORIGIN_INVALID', '管理员请求必须同源', 403);
  }
  const fetchSite = String(request?.headers?.get?.('sec-fetch-site') || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin') {
    throw new AdminAuthError('ADMIN_REQUEST_ORIGIN_INVALID', '管理员请求必须同源', 403);
  }
  return true;
}

export const ADMIN_AUTH_CAPABILITIES = Object.freeze({
  reviewQueueRead: false,
  reviewMutation: false,
  deviceMutation: false,
  rollback: false,
  export: false,
  publicMutationAllowed: false,
});
