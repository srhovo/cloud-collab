import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import {
  BlobRepositoryError,
  deleteBlobQuietly,
  deviceProfileKey,
  deviceTokenIndexKey,
  getJSONStrong,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';

export const DEVICE_REGISTRATION_SCHEMA_VERSION = 1;
export const DEVICE_TOKEN_VERSION = 1;
export const MAX_DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_DEVICE_TOKEN_TTL_MS = MAX_DEVICE_TOKEN_TTL_MS;

const CROCKFORD_ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const DEVICE_ID_PATTERN = new RegExp(`^dev_${CROCKFORD_ULID}$`);
const APP_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const TOKEN_PATTERN = /^dt_v1_[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH_PATTERN = /^dth_v1_[A-Za-z0-9_-]{43}$/;

export class DeviceRegistrationError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '设备注册失败');
    this.name = 'DeviceRegistrationError';
    this.code = code || 'DEVICE_REGISTRATION_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, keys, code, message) {
  if (!isPlainObject(value)) throw new DeviceRegistrationError(code, message);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new DeviceRegistrationError(code, message, 400, { actual, expected });
  }
}

function normalizeNickname(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  let text = String(value);
  try { text = text.normalize('NFKC'); } catch (_) {}
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 24 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new DeviceRegistrationError('INVALID_NICKNAME', '设备昵称长度必须为1至24字符且不能包含控制字符');
  }
  return text;
}

function normalizeRegistration(input) {
  assertExactKeys(input, ['schemaVersion', 'deviceId', 'nickname', 'clientContext'], 'INVALID_DEVICE_REGISTRATION_FIELDS', '设备注册字段必须严格符合协议');
  if (input.schemaVersion !== DEVICE_REGISTRATION_SCHEMA_VERSION) {
    throw new DeviceRegistrationError('UNSUPPORTED_DEVICE_REGISTRATION_SCHEMA', '设备注册协议版本不受支持');
  }
  const deviceId = String(input.deviceId || '').trim();
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new DeviceRegistrationError('INVALID_DEVICE_ID', 'deviceId格式无效');
  }
  assertExactKeys(input.clientContext, ['appVersion'], 'INVALID_DEVICE_CLIENT_CONTEXT', '设备注册clientContext字段无效');
  const appVersion = String(input.clientContext.appVersion || '').trim();
  if (!APP_VERSION_PATTERN.test(appVersion) || appVersion.length > 32) {
    throw new DeviceRegistrationError('INVALID_APP_VERSION', 'appVersion格式无效');
  }
  return Object.freeze({
    schemaVersion: DEVICE_REGISTRATION_SCHEMA_VERSION,
    deviceId,
    nickname: normalizeNickname(input.nickname),
    clientContext: Object.freeze({ appVersion }),
  });
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('base64url');
}

export function hashDeviceToken(token) {
  const value = String(token || '').trim();
  if (!TOKEN_PATTERN.test(value)) throw new DeviceRegistrationError('INVALID_DEVICE_TOKEN', '设备令牌格式无效', 401);
  return `dth_v1_${sha256Base64Url(value)}`;
}

export function parseBearerToken(authorization) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(authorization || '').trim());
  if (!match) throw new DeviceRegistrationError('DEVICE_AUTH_REQUIRED', '缺少有效设备Authorization', 401);
  const token = match[1];
  if (!TOKEN_PATTERN.test(token)) throw new DeviceRegistrationError('INVALID_DEVICE_TOKEN', '设备令牌格式无效', 401);
  return token;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerDevice({
  store,
  input,
  now = Date.now(),
  tokenTtlMs = DEFAULT_DEVICE_TOKEN_TTL_MS,
  randomBytes = nodeRandomBytes,
} = {}) {
  const registration = normalizeRegistration(input);
  if (!Number.isSafeInteger(now) || now <= 0) throw new DeviceRegistrationError('INVALID_SERVER_TIME', '服务器时间无效', 500);
  if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs < 60_000 || tokenTtlMs > MAX_DEVICE_TOKEN_TTL_MS) {
    throw new DeviceRegistrationError('INVALID_TOKEN_TTL', '设备令牌有效期必须位于1分钟至90天', 500);
  }
  const expiresAt = now + tokenTtlMs;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new DeviceRegistrationError('INVALID_TOKEN_EXPIRY', '设备令牌过期时间超出安全范围', 500);
  }

  const profileKey = deviceProfileKey(registration.deviceId);
  if (await getJSONStrong(store, profileKey)) {
    throw new DeviceRegistrationError('DEVICE_ALREADY_REGISTERED', '该deviceId已经注册，不能重复签发令牌', 409);
  }

  const tokenBytes = randomBytes(32);
  if (!tokenBytes || tokenBytes.length !== 32) throw new DeviceRegistrationError('TOKEN_GENERATION_FAILED', '设备令牌生成失败', 500);
  const deviceToken = `dt_v1_${Buffer.from(tokenBytes).toString('base64url')}`;
  const tokenHash = hashDeviceToken(deviceToken);
  if (!TOKEN_HASH_PATTERN.test(tokenHash)) throw new DeviceRegistrationError('TOKEN_HASH_FAILED', '设备令牌Hash生成失败', 500);

  const issuedAt = now;
  const tokenIndexKey = deviceTokenIndexKey(tokenHash);
  const tokenIndex = Object.freeze({
    schemaVersion: 1,
    deviceId: registration.deviceId,
    tokenHash,
    tokenVersion: DEVICE_TOKEN_VERSION,
    issuedAt,
    expiresAt,
  });
  const profile = Object.freeze({
    schemaVersion: 1,
    deviceId: registration.deviceId,
    nickname: registration.nickname,
    nicknameTag: registration.deviceId.slice(-4).toUpperCase(),
    tokenHash,
    tokenVersion: DEVICE_TOKEN_VERSION,
    issuedAt,
    expiresAt,
    createdAt: now,
    updatedAt: now,
    lastAppVersion: registration.clientContext.appVersion,
  });

  try {
    await putJSONOnlyIfNew(store, tokenIndexKey, tokenIndex);
    try {
      await putJSONOnlyIfNew(store, profileKey, profile);
    } catch (error) {
      await deleteBlobQuietly(store, tokenIndexKey);
      if (await getJSONStrong(store, profileKey)) {
        throw new DeviceRegistrationError('DEVICE_ALREADY_REGISTERED', '该deviceId已经注册，不能重复签发令牌', 409, null, error);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof DeviceRegistrationError) throw error;
    if (error instanceof BlobRepositoryError) {
      throw new DeviceRegistrationError('DEVICE_REGISTRATION_STORAGE_FAILED', '设备注册持久化失败', 503, error.details, error);
    }
    throw error;
  }

  return Object.freeze({
    schemaVersion: 1,
    deviceId: registration.deviceId,
    deviceToken,
    issuedAt,
    expiresAt,
    tokenVersion: DEVICE_TOKEN_VERSION,
    nicknameTag: profile.nicknameTag,
  });
}

export async function authenticateDevice({ store, authorization, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new DeviceRegistrationError('INVALID_SERVER_TIME', '服务器时间无效', 500);
  const deviceToken = parseBearerToken(authorization);
  const tokenHash = hashDeviceToken(deviceToken);
  const index = await getJSONStrong(store, deviceTokenIndexKey(tokenHash));
  if (!index || !TOKEN_HASH_PATTERN.test(String(index.tokenHash || '')) || !safeEqual(index.tokenHash, tokenHash)) {
    throw new DeviceRegistrationError('DEVICE_TOKEN_NOT_FOUND', '设备令牌无效或已撤销', 401);
  }
  if (!DEVICE_ID_PATTERN.test(String(index.deviceId || '')) || !Number.isSafeInteger(index.expiresAt) || index.expiresAt <= now) {
    throw new DeviceRegistrationError('DEVICE_TOKEN_EXPIRED', '设备令牌已过期', 401);
  }
  const profile = await getJSONStrong(store, deviceProfileKey(index.deviceId));
  if (!profile || !safeEqual(profile.tokenHash, tokenHash) || profile.tokenVersion !== index.tokenVersion) {
    throw new DeviceRegistrationError('DEVICE_PROFILE_MISMATCH', '设备档案与令牌不一致', 401);
  }
  return Object.freeze({
    deviceId: index.deviceId,
    tokenVersion: index.tokenVersion,
    expiresAt: index.expiresAt,
    nicknameTag: String(profile.nicknameTag || ''),
  });
}
