const DEVICE_SCHEMA_VERSION = 1;
const TOKEN_VERSION = 1;
const REGISTER_SCHEMA_VERSION = 1;
const MAX_REGISTER_BODY_BYTES = 8 * 1024;
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CROCKFORD_ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const DEVICE_ID_PATTERN = new RegExp(`^dev_${CROCKFORD_ULID}$`);
const APP_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export class DeviceRegistrationError extends Error {
  constructor(code, message, details = null) {
    super(message || code || '设备注册失败');
    this.name = 'DeviceRegistrationError';
    this.code = code || 'DEVICE_REGISTRATION_ERROR';
    this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, code, message) {
  if (!isPlainObject(value)) throw new DeviceRegistrationError(code, message);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new DeviceRegistrationError(code, message, { actual, expected: wanted });
  }
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DeviceRegistrationError('INVALID_CANONICAL_NUMBER', '规范对象含无效数字');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (!isPlainObject(value)) throw new DeviceRegistrationError('INVALID_CANONICAL_VALUE', '规范对象含不支持的值');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function cryptoApi() {
  const value = globalThis.crypto;
  if (!value?.subtle || typeof value.getRandomValues !== 'function') {
    throw new DeviceRegistrationError('WEB_CRYPTO_UNAVAILABLE', '当前运行环境不支持安全令牌签发');
  }
  return value;
}

function textEncoder() {
  if (typeof TextEncoder !== 'function') throw new DeviceRegistrationError('TEXT_ENCODER_UNAVAILABLE', '当前运行环境不支持文本编码');
  return new TextEncoder();
}

function textDecoder() {
  if (typeof TextDecoder !== 'function') throw new DeviceRegistrationError('TEXT_DECODER_UNAVAILABLE', '当前运行环境不支持文本解码');
  return new TextDecoder();
}

function bytesToBase64Url(bytes) {
  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
  throw new DeviceRegistrationError('BASE64_UNAVAILABLE', '当前运行环境不支持令牌编码');
}

function base64UrlToBytes(value) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new DeviceRegistrationError('INVALID_DEVICE_TOKEN', '设备令牌格式无效');
  if (typeof atob === 'function') {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
    let binary;
    try { binary = atob(padded); }
    catch (_) { throw new DeviceRegistrationError('INVALID_DEVICE_TOKEN', '设备令牌编码无效'); }
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }
  if (typeof Buffer !== 'undefined') {
    try { return new Uint8Array(Buffer.from(text, 'base64url')); }
    catch (_) { throw new DeviceRegistrationError('INVALID_DEVICE_TOKEN', '设备令牌编码无效'); }
  }
  throw new DeviceRegistrationError('BASE64_UNAVAILABLE', '当前运行环境不支持令牌解码');
}

async function sha256Base64Url(value) {
  const digest = await cryptoApi().subtle.digest('SHA-256', textEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function importHmacKey(secret) {
  const normalized = String(secret || '');
  if (textEncoder().encode(normalized).byteLength < 32) {
    throw new DeviceRegistrationError('DEVICE_TOKEN_SECRET_TOO_SHORT', '设备令牌密钥至少需要32字节');
  }
  return cryptoApi().subtle.importKey(
    'raw',
    textEncoder().encode(normalized),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function normalizeNickname(value) {
  if (value === null || value === undefined || value === '') return null;
  let text = String(value);
  try { text = text.normalize('NFKC'); } catch (_) {}
  if (/[\u0000-\u001F\u007F]/.test(text)) throw new DeviceRegistrationError('INVALID_NICKNAME', '昵称不能包含控制字符');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 24) throw new DeviceRegistrationError('INVALID_NICKNAME', '昵称长度必须为1至24个字符');
  return text;
}

function normalizeClientContext(value) {
  assertExactKeys(value, ['appVersion', 'protocolVersion'], 'INVALID_CLIENT_CONTEXT_FIELDS', 'clientContext字段无效');
  const appVersion = String(value.appVersion || '').trim();
  if (!APP_VERSION_PATTERN.test(appVersion) || appVersion.length > 32) {
    throw new DeviceRegistrationError('INVALID_APP_VERSION', 'appVersion格式无效');
  }
  if (value.protocolVersion !== 1) throw new DeviceRegistrationError('UNSUPPORTED_PROTOCOL_VERSION', '客户端协议版本不受支持');
  return Object.freeze({ appVersion, protocolVersion: 1 });
}

export function assertRegisterRequestBytes(rawBody, maxBytes = MAX_REGISTER_BODY_BYTES) {
  const text = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
  const bytes = textEncoder().encode(text).byteLength;
  if (bytes > maxBytes) {
    throw new DeviceRegistrationError('REGISTER_REQUEST_TOO_LARGE', `设备注册请求不得超过${maxBytes}字节`, { bytes, maxBytes });
  }
  return bytes;
}

export function normalizeRegisterRequest(value) {
  assertExactKeys(value, ['schemaVersion', 'deviceId', 'nickname', 'clientContext'], 'INVALID_REGISTER_FIELDS', '设备注册字段必须严格符合白名单');
  if (value.schemaVersion !== REGISTER_SCHEMA_VERSION) throw new DeviceRegistrationError('UNSUPPORTED_REGISTER_SCHEMA', '设备注册协议版本不受支持');
  const deviceId = String(value.deviceId || '').trim();
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new DeviceRegistrationError('INVALID_DEVICE_ID', 'deviceId格式无效');
  return Object.freeze({
    schemaVersion: REGISTER_SCHEMA_VERSION,
    deviceId,
    nickname: normalizeNickname(value.nickname),
    clientContext: normalizeClientContext(value.clientContext),
  });
}

function randomNonce() {
  const bytes = new Uint8Array(16);
  cryptoApi().getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function issueDeviceToken({ deviceId, tokenVersion, secret, issuedAt, expiresAt, nonce = null }) {
  if (!DEVICE_ID_PATTERN.test(String(deviceId || ''))) throw new DeviceRegistrationError('INVALID_DEVICE_ID', 'deviceId格式无效');
  if (!Number.isInteger(tokenVersion) || tokenVersion < 1) throw new DeviceRegistrationError('INVALID_TOKEN_VERSION', 'tokenVersion无效');
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
    throw new DeviceRegistrationError('INVALID_TOKEN_TIME', '设备令牌时间范围无效');
  }
  const normalizedNonce = nonce || randomNonce();
  if (!TOKEN_NONCE_PATTERN.test(normalizedNonce)) throw new DeviceRegistrationError('INVALID_TOKEN_NONCE', '设备令牌随机数无效');
  const payload = Object.freeze({
    version: TOKEN_VERSION,
    deviceId,
    tokenVersion,
    issuedAt,
    expiresAt,
    nonce: normalizedNonce,
  });
  const encodedPayload = bytesToBase64Url(textEncoder().encode(canonicalize(payload)));
  const key = await importHmacKey(secret);
  const signature = await cryptoApi().subtle.sign('HMAC', key, textEncoder().encode(`dt_v1.${encodedPayload}`));
  const token = `dt_v1.${encodedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`;
  return Object.freeze({ token, payload, tokenHash: await sha256Base64Url(token) });
}

export async function verifyDeviceToken(token, { secret, now = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'dt_v1') throw new DeviceRegistrationError('INVALID_DEVICE_TOKEN', '设备令牌格式无效');
  const [prefix, encodedPayload, encodedSignature] = parts;
  const key = await importHmacKey(secret);
  const valid = await cryptoApi().subtle.verify(
    'HMAC',
    key,
    base64UrlToBytes(encodedSignature),
    textEncoder().encode(`${prefix}.${encodedPayload}`),
  );
  if (!valid) throw new DeviceRegistrationError('INVALID_DEVICE_TOKEN_SIGNATURE', '设备令牌签名无效');
  let payload;
  try { payload = JSON.parse(textDecoder().decode(base64UrlToBytes(encodedPayload))); }
  catch (_) { throw new DeviceRegistrationError('INVALID_DEVICE_TOKEN_PAYLOAD', '设备令牌内容无效'); }
  assertExactKeys(payload, ['version', 'deviceId', 'tokenVersion', 'issuedAt', 'expiresAt', 'nonce'], 'INVALID_DEVICE_TOKEN_PAYLOAD', '设备令牌字段无效');
  if (payload.version !== TOKEN_VERSION || !DEVICE_ID_PATTERN.test(payload.deviceId) || !TOKEN_NONCE_PATTERN.test(payload.nonce)) {
    throw new DeviceRegistrationError('INVALID_DEVICE_TOKEN_PAYLOAD', '设备令牌身份无效');
  }
  if (!Number.isInteger(payload.tokenVersion) || payload.tokenVersion < 1
    || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt <= payload.issuedAt) {
    throw new DeviceRegistrationError('INVALID_DEVICE_TOKEN_PAYLOAD', '设备令牌版本或时间无效');
  }
  if (payload.expiresAt <= now) throw new DeviceRegistrationError('DEVICE_TOKEN_EXPIRED', '设备令牌已过期');
  return Object.freeze({ payload: Object.freeze(payload), tokenHash: await sha256Base64Url(token) });
}

export function deviceStorageKey(deviceId) {
  if (!DEVICE_ID_PATTERN.test(String(deviceId || ''))) throw new DeviceRegistrationError('INVALID_DEVICE_ID', 'deviceId格式无效');
  return `device:v1:${deviceId}`;
}

function parseStoredDevice(raw, deviceId) {
  if (raw === null || raw === undefined || raw === '') return null;
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (_) { throw new DeviceRegistrationError('DEVICE_RECORD_CORRUPT', '设备记录无法解析'); }
  assertExactKeys(value, [
    'schemaVersion', 'deviceId', 'nickname', 'nicknameTag', 'status', 'trusted',
    'tokenVersion', 'tokenHash', 'issuedAt', 'expiresAt', 'createdAt',
    'lastRegisteredAt', 'lastClientContext',
  ], 'DEVICE_RECORD_CORRUPT', '设备记录字段无效');
  if (value.schemaVersion !== DEVICE_SCHEMA_VERSION || value.deviceId !== deviceId
    || !DEVICE_ID_PATTERN.test(value.deviceId) || value.nicknameTag !== value.deviceId.slice(-4)) {
    throw new DeviceRegistrationError('DEVICE_RECORD_CORRUPT', '设备记录身份无效');
  }
  if (!['active', 'banned'].includes(value.status) || typeof value.trusted !== 'boolean'
    || !Number.isInteger(value.tokenVersion) || value.tokenVersion < 1
    || !TOKEN_HASH_PATTERN.test(value.tokenHash)) {
    throw new DeviceRegistrationError('DEVICE_RECORD_CORRUPT', '设备记录状态无效');
  }
  for (const key of ['issuedAt', 'expiresAt', 'createdAt', 'lastRegisteredAt']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new DeviceRegistrationError('DEVICE_RECORD_CORRUPT', '设备记录时间无效');
  }
  normalizeClientContext(value.lastClientContext);
  if (value.nickname !== null) normalizeNickname(value.nickname);
  return Object.freeze(value);
}

async function readStoredDevice(kv, deviceId) {
  if (!kv || typeof kv.get !== 'function') throw new DeviceRegistrationError('DEVICE_REGISTRY_NOT_CONFIGURED', '设备注册存储尚未配置');
  try { return parseStoredDevice(await kv.get(deviceStorageKey(deviceId)), deviceId); }
  catch (error) {
    if (error instanceof DeviceRegistrationError) throw error;
    throw new DeviceRegistrationError('DEVICE_REGISTRY_READ_FAILED', '读取设备注册信息失败');
  }
}

export async function authenticateDeviceToken({ authorization, kv, secret, now = Date.now() } = {}) {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || '').trim());
  if (!match) throw new DeviceRegistrationError('DEVICE_TOKEN_REQUIRED', '缺少设备令牌');
  const verified = await verifyDeviceToken(match[1], { secret, now });
  const record = await readStoredDevice(kv, verified.payload.deviceId);
  if (!record) throw new DeviceRegistrationError('DEVICE_NOT_REGISTERED', '设备尚未注册');
  if (record.status === 'banned') throw new DeviceRegistrationError('DEVICE_BANNED', '该设备已被禁用');
  if (record.expiresAt <= now) throw new DeviceRegistrationError('DEVICE_TOKEN_EXPIRED', '设备令牌已过期');
  if (record.tokenVersion !== verified.payload.tokenVersion || record.tokenHash !== verified.tokenHash) {
    throw new DeviceRegistrationError('DEVICE_TOKEN_REVOKED', '设备令牌已失效');
  }
  return Object.freeze({
    deviceId: record.deviceId,
    nickname: record.nickname,
    nicknameTag: record.nicknameTag,
    trusted: record.trusted,
    tokenVersion: record.tokenVersion,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  });
}

export async function registerDevice({
  request,
  kv,
  secret,
  now = Date.now(),
  ttlMs = DEFAULT_TOKEN_TTL_MS,
} = {}) {
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    throw new DeviceRegistrationError('DEVICE_REGISTRY_NOT_CONFIGURED', '设备注册存储尚未配置');
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > MAX_TOKEN_TTL_MS) {
    throw new DeviceRegistrationError('INVALID_TOKEN_TTL', '设备令牌有效期配置无效');
  }
  const normalized = normalizeRegisterRequest(request);
  const existing = await readStoredDevice(kv, normalized.deviceId);
  if (existing?.status === 'banned') throw new DeviceRegistrationError('DEVICE_BANNED', '该设备已被禁用');
  if (existing) throw new DeviceRegistrationError('DEVICE_ALREADY_REGISTERED', '该设备已注册；令牌轮换必须使用已鉴权接口');

  const issued = await issueDeviceToken({
    deviceId: normalized.deviceId,
    tokenVersion: 1,
    secret,
    issuedAt: now,
    expiresAt: now + ttlMs,
  });
  const record = Object.freeze({
    schemaVersion: DEVICE_SCHEMA_VERSION,
    deviceId: normalized.deviceId,
    nickname: normalized.nickname,
    nicknameTag: normalized.deviceId.slice(-4),
    status: 'active',
    trusted: false,
    tokenVersion: 1,
    tokenHash: issued.tokenHash,
    issuedAt: issued.payload.issuedAt,
    expiresAt: issued.payload.expiresAt,
    createdAt: now,
    lastRegisteredAt: now,
    lastClientContext: normalized.clientContext,
  });
  try { await kv.put(deviceStorageKey(normalized.deviceId), JSON.stringify(record)); }
  catch (_) { throw new DeviceRegistrationError('DEVICE_REGISTRY_WRITE_FAILED', '保存设备注册信息失败'); }
  return Object.freeze({
    device: Object.freeze({
      deviceId: record.deviceId,
      nickname: record.nickname,
      nicknameTag: record.nicknameTag,
      tokenVersion: record.tokenVersion,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    }),
    credential: Object.freeze({
      token: issued.token,
      tokenVersion: record.tokenVersion,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    }),
  });
}

export const DEVICE_REGISTRATION_LIMITS = Object.freeze({
  registerSchemaVersion: REGISTER_SCHEMA_VERSION,
  deviceSchemaVersion: DEVICE_SCHEMA_VERSION,
  tokenVersion: TOKEN_VERSION,
  maxRegisterBodyBytes: MAX_REGISTER_BODY_BYTES,
  defaultTokenTtlMs: DEFAULT_TOKEN_TTL_MS,
  maxTokenTtlMs: MAX_TOKEN_TTL_MS,
});
