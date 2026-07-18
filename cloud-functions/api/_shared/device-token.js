import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WriteFoundationError } from './http.js';

const TOKEN_PREFIX = 'dvt1';
const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function encode(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(value) {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch (_) { throw new WriteFoundationError('INVALID_DEVICE_TOKEN', '设备令牌格式无效', { status: 401 }); }
}

function requireSecret(secret) {
  const value = String(secret || '');
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new WriteFoundationError('TOKEN_SECRET_NOT_CONFIGURED', '设备令牌签名密钥尚未安全配置', { status: 503, retryable: true });
  }
  return value;
}

function sign(input, secret) {
  return createHmac('sha256', requireSecret(secret)).update(input, 'utf8').digest('base64url');
}

export function issueDeviceToken({ deviceId, tokenVersion = 1, issuedAt, expiresAt, tokenId = null }, secret) {
  if (!DEVICE_ID_PATTERN.test(String(deviceId || ''))) {
    throw new WriteFoundationError('INVALID_DEVICE_ID', 'deviceId格式无效', { status: 400 });
  }
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
    throw new WriteFoundationError('INVALID_TOKEN_TIME', '设备令牌时间范围无效', { status: 500 });
  }
  const payload = Object.freeze({
    v: 1,
    deviceId,
    tokenVersion: Math.max(1, Number(tokenVersion) || 1),
    issuedAt,
    expiresAt,
    tokenId: tokenId || randomBytes(16).toString('base64url'),
  });
  const encodedPayload = encode(payload);
  const input = `${TOKEN_PREFIX}.${encodedPayload}`;
  return { token: `${input}.${sign(input, secret)}`, payload };
}

export function verifyDeviceToken(token, secret, { now = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw new WriteFoundationError('INVALID_DEVICE_TOKEN', '设备令牌格式无效', { status: 401 });
  }
  const input = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(input, secret), 'utf8');
  const actual = Buffer.from(parts[2], 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new WriteFoundationError('INVALID_DEVICE_TOKEN', '设备令牌签名无效', { status: 401 });
  }
  const payload = decodeJson(parts[1]);
  if (!exactKeys(payload, ['v', 'deviceId', 'tokenVersion', 'issuedAt', 'expiresAt', 'tokenId'])
    || payload.v !== 1
    || !DEVICE_ID_PATTERN.test(String(payload.deviceId || ''))
    || !Number.isSafeInteger(payload.issuedAt)
    || !Number.isSafeInteger(payload.expiresAt)
    || !Number.isInteger(payload.tokenVersion)
    || payload.tokenVersion < 1
    || typeof payload.tokenId !== 'string'
    || payload.tokenId.length < 16) {
    throw new WriteFoundationError('INVALID_DEVICE_TOKEN', '设备令牌内容无效', { status: 401 });
  }
  if (payload.expiresAt <= now) {
    throw new WriteFoundationError('DEVICE_TOKEN_EXPIRED', '设备令牌已过期', { status: 401 });
  }
  if (payload.issuedAt > now + 60_000) {
    throw new WriteFoundationError('DEVICE_TOKEN_NOT_YET_VALID', '设备令牌签发时间异常', { status: 401 });
  }
  return Object.freeze(payload);
}

export function readBearerToken(request) {
  const header = String(request?.headers?.get?.('authorization') || '');
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  if (!match) throw new WriteFoundationError('DEVICE_TOKEN_REQUIRED', '需要设备令牌', { status: 401 });
  return match[1];
}
