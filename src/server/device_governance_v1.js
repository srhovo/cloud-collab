import { createHash, createHmac } from 'node:crypto';
import {
  BlobRepositoryError,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import { canonicalize } from './submission_policy_v1.js';

export const DEVICE_GOVERNANCE_SCHEMA_VERSION = 1;
export const DEVICE_GOVERNANCE_MAX_BODY_BYTES = 768;
export const DEVICE_GOVERNANCE_PREVIEW_STORE_NAME = 'cloud-collab-preview-v1';
export const MAX_ADMIN_DEVICE_PROFILES = 500;
export const MAX_DEVICE_GOVERNANCE_EVENTS = 200;

const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_REF_PATTERN = /^devref_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_PATTERN = /^dgrq_v1_[A-Za-z0-9_-]{22,64}$/;
const REQUEST_HASH_PATTERN = /^dgrh_v1_[A-Za-z0-9_-]{43}$/;
const EVENT_ID_PATTERN = /^dge_v1_[A-Za-z0-9_-]{43}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;
const APP_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const ACTIONS = new Set(['trust', 'revoke_trust', 'block', 'unblock']);
const REASONS = Object.freeze({
  trust: new Set(['verified_operator']),
  revoke_trust: new Set(['trust_withdrawn']),
  block: new Set(['abuse', 'credential_compromise', 'rate_abuse', 'manual_safety']),
  unblock: new Set(['manual_review_cleared']),
});

export const ADMIN_DEVICE_GOVERNANCE_CAPABILITIES = Object.freeze({
  deviceListRead: true,
  deviceDetailRead: true,
  deviceTrust: true,
  deviceTrustRevoke: true,
  deviceBlock: true,
  deviceUnblock: true,
  reviewMutation: false,
  rollback: false,
  export: false,
  publicMutationAllowed: false,
  syntheticFixtureOnly: true,
});

export class DeviceGovernanceError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '管理员设备治理失败');
    this.name = 'DeviceGovernanceError';
    this.code = code || 'DEVICE_GOVERNANCE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, code, message, status = 400) {
  if (!isPlainObject(value)) throw new DeviceGovernanceError(code, message, status);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new DeviceGovernanceError(code, message, status, { actual, expected: wanted });
  }
}

function secretByteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function assertSecret(value, code, label) {
  const text = String(value || '');
  const bytes = secretByteLength(text);
  if (bytes < 32 || bytes > 256) {
    throw new DeviceGovernanceError(code, `${label}必须为32至256字节`, 503);
  }
  return text;
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function hmacBase64Url(value, secret) {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(String(value), 'utf8').digest('base64url');
}

function actorTagFor(identity) {
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!username) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_ACTOR_INVALID', '管理员身份无效', 401);
  return `admin_${sha256Base64Url(username).slice(0, 12)}`;
}

function assertSafeTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_TIME_INVALID', '设备治理时间无效', 500);
  }
  return value;
}

function normalizeDeviceId(value) {
  const deviceId = String(value || '').trim();
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_DEVICE_INVALID', '设备身份无效', 503);
  }
  return deviceId;
}

function normalizeDeviceRef(value) {
  const deviceRef = String(value || '').trim();
  if (!DEVICE_REF_PATTERN.test(deviceRef)) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_DEVICE_REF_INVALID', '设备引用无效', 400);
  }
  return deviceRef;
}

function normalizeRequestId(value) {
  const requestId = String(value || '').trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_REQUEST_ID_INVALID', '设备治理请求ID无效', 400);
  }
  return requestId;
}

function normalizeAction(value) {
  const action = String(value || '').trim();
  if (!ACTIONS.has(action)) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_ACTION_INVALID', '设备治理动作无效', 400);
  return action;
}

function normalizeReason(action, value) {
  const reasonCode = String(value || '').trim();
  if (!REASONS[action]?.has(reasonCode)) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_REASON_INVALID', '设备治理原因无效', 400);
  }
  return reasonCode;
}

export function readDeviceGovernanceConfig(env = {}) {
  if (String(env.CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_PREVIEW_DISABLED', '管理员设备治理预览未开启', 503);
  }
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '0').trim() === '1'
      || String(env.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED || '0').trim() === '1'
      || String(env.CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED || '0').trim() === '1') {
    throw new DeviceGovernanceError(
      'DEVICE_GOVERNANCE_REQUIRES_OTHER_MUTATIONS_CLOSED',
      '设备治理预览要求公共写入、自动审核和审核写入全部关闭',
      503,
    );
  }
  const storeName = String(env.CLOUD_ADMIN_DEVICE_GOVERNANCE_BLOB_STORE_NAME || '').trim();
  if (storeName !== DEVICE_GOVERNANCE_PREVIEW_STORE_NAME) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_SCOPE_INVALID', '设备治理只允许使用合成预览Blob', 503);
  }
  const deviceRefSalt = assertSecret(
    env.CLOUD_ADMIN_DEVICE_REF_SALT,
    'DEVICE_GOVERNANCE_REF_SALT_INVALID',
    '设备脱敏引用盐值',
  );
  const otherSecrets = [
    env.CLOUD_ADMIN_PASSWORD,
    env.CLOUD_ADMIN_SESSION_SECRET,
    env.CLOUD_ADMIN_RATE_LIMIT_SALT,
    env.CLOUD_WRITE_PREVIEW_KEY,
    env.CLOUD_RATE_LIMIT_SALT,
  ].map(value => String(value || '')).filter(Boolean);
  if (otherSecrets.includes(deviceRefSalt)) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_REF_SALT_REUSED', '设备脱敏引用盐值不得复用其他凭据', 503);
  }
  return Object.freeze({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    storeName,
    deviceRefSalt,
  });
}

export function deviceRefFor(deviceId, salt) {
  return `devref_v1_${hmacBase64Url(normalizeDeviceId(deviceId), assertSecret(salt, 'DEVICE_GOVERNANCE_REF_SALT_INVALID', '设备脱敏引用盐值'))}`;
}

function governanceHeadKey(deviceId) {
  return normalizeBlobKey(`devices/governance/heads/${normalizeDeviceId(deviceId)}.json`);
}

function governanceEventPrefix(deviceId) {
  return `${normalizeBlobKey(`devices/governance/events/${normalizeDeviceId(deviceId)}`)}/`;
}

function governanceEventKey(deviceId, version, eventId) {
  if (!Number.isSafeInteger(version) || version < 1 || version > 999_999_999_999) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_VERSION_INVALID', '设备治理版本无效', 500);
  }
  if (!EVENT_ID_PATTERN.test(String(eventId || ''))) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_EVENT_INVALID', '设备治理事件ID无效', 500);
  }
  return normalizeBlobKey(`${governanceEventPrefix(deviceId)}${String(version).padStart(12, '0')}-${eventId}.json`);
}

function governanceTransitionKey(deviceId, fromVersion) {
  if (!Number.isSafeInteger(fromVersion) || fromVersion < 0 || fromVersion > 999_999_999_999) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_VERSION_INVALID', '设备治理基线版本无效', 500);
  }
  return normalizeBlobKey(`devices/governance/transitions/${normalizeDeviceId(deviceId)}/${String(fromVersion).padStart(12, '0')}.json`);
}

function governanceRequestKey(requestHash) {
  if (!REQUEST_HASH_PATTERN.test(String(requestHash || ''))) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_REQUEST_HASH_INVALID', '设备治理请求摘要无效', 500);
  }
  return normalizeBlobKey(`devices/governance/requests/${requestHash}.json`);
}

function governanceAuditKey(eventId, createdAt) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_AUDIT_TIME_INVALID', '设备治理审计时间无效', 500);
  return normalizeBlobKey(`audit/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${eventId}.json`);
}

function legacyTrustedKey(deviceId) {
  return normalizeBlobKey(`devices/trusted/${normalizeDeviceId(deviceId)}.json`);
}

function normalizeHead(value, deviceId) {
  assertExactKeys(value, [
    'schemaVersion', 'deviceId', 'version', 'trusted', 'blocked', 'lastAction', 'updatedAt', 'lastEventId',
  ], 'DEVICE_GOVERNANCE_HEAD_INVALID', '设备治理状态结构无效', 503);
  if (value.schemaVersion !== DEVICE_GOVERNANCE_SCHEMA_VERSION
      || value.deviceId !== deviceId
      || !Number.isSafeInteger(value.version) || value.version < 1
      || typeof value.trusted !== 'boolean'
      || typeof value.blocked !== 'boolean'
      || !ACTIONS.has(value.lastAction)
      || !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0
      || !EVENT_ID_PATTERN.test(String(value.lastEventId || ''))
      || (value.blocked && value.trusted)) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_HEAD_INVALID', '设备治理状态内容无效', 503);
  }
  return Object.freeze({ ...value });
}

async function readHeadOrNull(store, deviceId) {
  const value = await getJSONStrong(store, governanceHeadKey(deviceId));
  return value ? normalizeHead(value, deviceId) : null;
}

async function readLegacyTrusted(store, deviceId) {
  const record = await getJSONStrong(store, legacyTrustedKey(deviceId));
  if (!record) return false;
  const valid = record.schemaVersion === 1
    && record.deviceId === deviceId
    && typeof record.trusted === 'boolean'
    && Number.isSafeInteger(record.trustedAt) && record.trustedAt > 0
    && (record.revokedAt === null || (Number.isSafeInteger(record.revokedAt) && record.revokedAt > 0));
  if (!valid) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_LEGACY_TRUST_INVALID', '旧可信设备记录无效', 503);
  return record.trusted === true && record.revokedAt === null;
}

export async function readEffectiveDeviceGovernance({ store, deviceId } = {}) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  const head = await readHeadOrNull(store, normalizedDeviceId);
  if (head) return head;
  const trusted = await readLegacyTrusted(store, normalizedDeviceId);
  return Object.freeze({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    deviceId: normalizedDeviceId,
    version: 0,
    trusted,
    blocked: false,
    lastAction: null,
    updatedAt: null,
    lastEventId: null,
  });
}

function assertProfile(profile, deviceId) {
  if (!isPlainObject(profile)
      || profile.schemaVersion !== 1
      || profile.deviceId !== deviceId
      || typeof profile.nicknameTag !== 'string'
      || profile.nicknameTag.length > 8
      || !(profile.nickname === null || typeof profile.nickname === 'string')
      || !Number.isSafeInteger(profile.createdAt) || profile.createdAt <= 0
      || !Number.isSafeInteger(profile.updatedAt) || profile.updatedAt <= 0
      || !Number.isSafeInteger(profile.issuedAt) || profile.issuedAt <= 0
      || !Number.isSafeInteger(profile.expiresAt) || profile.expiresAt <= profile.issuedAt
      || !APP_VERSION_PATTERN.test(String(profile.lastAppVersion || ''))) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_PROFILE_INVALID', '设备档案结构无效', 503);
  }
  return profile;
}

async function listKeysStrong(store, prefix, maxObjects, code) {
  if (!store || typeof store.list !== 'function') {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_LIST_UNAVAILABLE', '设备治理需要Blob list能力', 503);
  }
  let result;
  try {
    result = await store.list({ prefix, consistency: 'strong' });
  } catch (error) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_LIST_FAILED', '强一致列举设备数据失败', 503, null, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > maxObjects) throw new DeviceGovernanceError(code, '设备治理对象数量超过安全上限', 409);
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_LIST_INVALID', '设备治理列举结果无效', 503);
  }
  return keys.sort();
}

function deviceIdFromProfileKey(key) {
  const match = /^devices\/profiles\/(dev_[0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(key);
  return match?.[1] || null;
}

function projectDevice(profile, state, config) {
  return Object.freeze({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    deviceRef: deviceRefFor(profile.deviceId, config.deviceRefSalt),
    displayName: profile.nickname ? `${profile.nickname} · ${profile.nicknameTag}` : `匿名设备 · ${profile.nicknameTag}`,
    nicknameTag: profile.nicknameTag,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    issuedAt: profile.issuedAt,
    expiresAt: profile.expiresAt,
    lastAppVersion: profile.lastAppVersion,
    trusted: state.trusted,
    blocked: state.blocked,
    governanceVersion: state.version,
    governanceUpdatedAt: state.updatedAt,
  });
}

async function resolveDeviceByRef({ store, config, deviceRef } = {}) {
  const normalizedRef = normalizeDeviceRef(deviceRef);
  const keys = await listKeysStrong(store, 'devices/profiles/', MAX_ADMIN_DEVICE_PROFILES, 'DEVICE_GOVERNANCE_PROFILE_LIMIT_EXCEEDED');
  let match = null;
  for (const key of keys) {
    const deviceId = deviceIdFromProfileKey(key);
    if (!deviceId) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_PROFILE_KEY_INVALID', '设备档案目录包含无效对象', 503);
    if (deviceRefFor(deviceId, config.deviceRefSalt) === normalizedRef) {
      if (match) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_DEVICE_REF_COLLISION', '设备引用发生冲突', 500);
      match = { deviceId, key };
    }
  }
  if (!match) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_DEVICE_NOT_FOUND', '设备不存在', 404);
  const profile = assertProfile(await getJSONStrong(store, match.key), match.deviceId);
  return { profile, deviceId: match.deviceId };
}

function normalizeEvent(value, expected = {}) {
  assertExactKeys(value, [
    'schemaVersion', 'eventId', 'requestHash', 'deviceId', 'action', 'reasonCode', 'actorTag',
    'fromVersion', 'version', 'previousTrusted', 'previousBlocked', 'trusted', 'blocked', 'createdAt',
  ], 'DEVICE_GOVERNANCE_EVENT_INVALID', '设备治理事件结构无效', 503);
  if (value.schemaVersion !== DEVICE_GOVERNANCE_SCHEMA_VERSION
      || !EVENT_ID_PATTERN.test(String(value.eventId || ''))
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || ''))
      || !DEVICE_ID_PATTERN.test(String(value.deviceId || ''))
      || !ACTIONS.has(value.action)
      || !REASONS[value.action]?.has(value.reasonCode)
      || !ACTOR_TAG_PATTERN.test(String(value.actorTag || ''))
      || !Number.isSafeInteger(value.fromVersion) || value.fromVersion < 0
      || value.version !== value.fromVersion + 1
      || typeof value.previousTrusted !== 'boolean'
      || typeof value.previousBlocked !== 'boolean'
      || typeof value.trusted !== 'boolean'
      || typeof value.blocked !== 'boolean'
      || (value.blocked && value.trusted)
      || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
      || (expected.deviceId && value.deviceId !== expected.deviceId)
      || (expected.requestHash && value.requestHash !== expected.requestHash)) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_EVENT_INVALID', '设备治理事件内容无效', 503);
  }
  return Object.freeze({ ...value });
}

function projectEvent(event) {
  return Object.freeze({
    schemaVersion: event.schemaVersion,
    action: event.action,
    reasonCode: event.reasonCode,
    actorTag: event.actorTag,
    fromVersion: event.fromVersion,
    version: event.version,
    previousTrusted: event.previousTrusted,
    previousBlocked: event.previousBlocked,
    trusted: event.trusted,
    blocked: event.blocked,
    createdAt: event.createdAt,
  });
}

export async function listAdminDevices({ store, config } = {}) {
  const keys = await listKeysStrong(store, 'devices/profiles/', MAX_ADMIN_DEVICE_PROFILES, 'DEVICE_GOVERNANCE_PROFILE_LIMIT_EXCEEDED');
  const devices = [];
  for (const key of keys) {
    const deviceId = deviceIdFromProfileKey(key);
    if (!deviceId) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_PROFILE_KEY_INVALID', '设备档案目录包含无效对象', 503);
    const profile = assertProfile(await getJSONStrong(store, key), deviceId);
    const state = await readEffectiveDeviceGovernance({ store, deviceId });
    devices.push(projectDevice(profile, state, config));
  }
  devices.sort((left, right) => right.createdAt - left.createdAt || left.deviceRef.localeCompare(right.deviceRef));
  return Object.freeze({ schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION, count: devices.length, devices: Object.freeze(devices) });
}

export async function getAdminDeviceDetail({ store, config, deviceRef } = {}) {
  const { profile, deviceId } = await resolveDeviceByRef({ store, config, deviceRef });
  const state = await readEffectiveDeviceGovernance({ store, deviceId });
  const keys = await listKeysStrong(
    store,
    governanceEventPrefix(deviceId),
    MAX_DEVICE_GOVERNANCE_EVENTS,
    'DEVICE_GOVERNANCE_EVENT_LIMIT_EXCEEDED',
  );
  const events = [];
  for (const key of keys) {
    const event = normalizeEvent(await getJSONStrong(store, key), { deviceId });
    events.push(projectEvent(event));
  }
  events.sort((left, right) => right.version - left.version);
  return Object.freeze({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    device: projectDevice(profile, state, config),
    events: Object.freeze(events),
  });
}

function requestHashFor(action, input) {
  return `dgrh_v1_${sha256Base64Url(canonicalize({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    action,
    deviceRef: input.deviceRef,
    requestId: input.requestId,
    reasonCode: input.reasonCode,
  }))}`;
}

function eventIdFor(requestHash) {
  return `dge_v1_${sha256Base64Url(requestHash)}`;
}

function nextState(action, state) {
  if (action === 'trust') {
    if (state.blocked) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_BLOCKED_CANNOT_TRUST', '封禁设备不能设为可信', 409);
    if (state.trusted) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_ALREADY_TRUSTED', '设备已经是可信状态', 409);
    return { trusted: true, blocked: false };
  }
  if (action === 'revoke_trust') {
    if (!state.trusted) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_ALREADY_UNTRUSTED', '设备当前不是可信状态', 409);
    return { trusted: false, blocked: state.blocked };
  }
  if (action === 'block') {
    if (state.blocked) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_ALREADY_BLOCKED', '设备已经被封禁', 409);
    return { trusted: false, blocked: true };
  }
  if (!state.blocked) throw new DeviceGovernanceError('DEVICE_GOVERNANCE_NOT_BLOCKED', '设备当前未被封禁', 409);
  return { trusted: false, blocked: false };
}

function isAlreadyExists(error) {
  return error instanceof BlobRepositoryError && error.code === 'BLOB_ALREADY_EXISTS';
}

async function putImmutableExact(store, key, value, conflictCode, conflictMessage) {
  try {
    await putJSONOnlyIfNew(store, key, value);
    return Object.freeze({ value, created: true });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await getJSONStrong(store, key);
    if (!existing || canonicalize(existing) !== canonicalize(value)) {
      throw new DeviceGovernanceError(conflictCode, conflictMessage, 409, null, error);
    }
    return Object.freeze({ value: existing, created: false });
  }
}

async function writeHeadProjection(store, proposed) {
  const key = governanceHeadKey(proposed.deviceId);
  const current = await readHeadOrNull(store, proposed.deviceId);
  if (current && current.version > proposed.version) return current;
  if (current && current.version === proposed.version) {
    if (canonicalize(current) !== canonicalize(proposed)) {
      throw new DeviceGovernanceError('DEVICE_GOVERNANCE_HEAD_CONFLICT', '设备治理状态投影冲突', 409);
    }
    return current;
  }
  try {
    await store.setJSON(key, proposed);
  } catch (error) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_HEAD_WRITE_FAILED', '设备治理状态投影写入失败', 503, null, error);
  }
  const stored = await getJSONStrong(store, key);
  const normalized = normalizeHead(stored, proposed.deviceId);
  if (normalized.version < proposed.version) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_HEAD_NOT_VISIBLE', '设备治理状态投影未强一致可见', 503);
  }
  return normalized;
}

async function findExistingEventForRequest(store, deviceId, requestHash) {
  const keys = await listKeysStrong(
    store,
    governanceEventPrefix(deviceId),
    MAX_DEVICE_GOVERNANCE_EVENTS,
    'DEVICE_GOVERNANCE_EVENT_LIMIT_EXCEEDED',
  );
  for (const key of keys) {
    const event = normalizeEvent(await getJSONStrong(store, key), { deviceId });
    if (event.requestHash === requestHash) return event;
  }
  return null;
}

async function finishEvent({ store, event, deviceRef, duplicate }) {
  const head = Object.freeze({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    deviceId: event.deviceId,
    version: event.version,
    trusted: event.trusted,
    blocked: event.blocked,
    lastAction: event.action,
    updatedAt: event.createdAt,
    lastEventId: event.eventId,
  });
  await writeHeadProjection(store, head);
  const requestIndex = Object.freeze({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    requestHash: event.requestHash,
    deviceId: event.deviceId,
    eventId: event.eventId,
    version: event.version,
    action: event.action,
    createdAt: event.createdAt,
  });
  await putImmutableExact(
    store,
    governanceRequestKey(event.requestHash),
    requestIndex,
    'DEVICE_GOVERNANCE_REQUEST_CONFLICT',
    '设备治理请求索引冲突',
  );
  const audit = Object.freeze({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    eventId: event.eventId,
    actorTag: event.actorTag,
    action: event.action,
    reasonCode: event.reasonCode,
    version: event.version,
    createdAt: event.createdAt,
  });
  await putImmutableExact(
    store,
    governanceAuditKey(event.eventId, event.createdAt),
    audit,
    'DEVICE_GOVERNANCE_AUDIT_CONFLICT',
    '设备治理审计冲突',
  );
  return Object.freeze({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    deviceRef,
    action: event.action,
    reasonCode: event.reasonCode,
    trusted: event.trusted,
    blocked: event.blocked,
    governanceVersion: event.version,
    governanceUpdatedAt: event.createdAt,
    duplicate: Boolean(duplicate),
  });
}

export async function mutateDeviceGovernance({ store, config, identity, command, now = Date.now() } = {}) {
  assertSafeTime(now);
  assertExactKeys(command, ['action', 'input'], 'DEVICE_GOVERNANCE_COMMAND_INVALID', '设备治理命令无效');
  const action = normalizeAction(command.action);
  assertExactKeys(
    command.input,
    ['schemaVersion', 'deviceRef', 'requestId', 'reasonCode'],
    'DEVICE_GOVERNANCE_INPUT_INVALID',
    '设备治理输入字段无效',
  );
  if (command.input.schemaVersion !== DEVICE_GOVERNANCE_SCHEMA_VERSION) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_SCHEMA_UNSUPPORTED', '设备治理协议版本不受支持', 400);
  }
  const input = Object.freeze({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    deviceRef: normalizeDeviceRef(command.input.deviceRef),
    requestId: normalizeRequestId(command.input.requestId),
    reasonCode: normalizeReason(action, command.input.reasonCode),
  });
  const requestHash = requestHashFor(action, input);
  const { deviceId } = await resolveDeviceByRef({ store, config, deviceRef: input.deviceRef });

  const indexed = await getJSONStrong(store, governanceRequestKey(requestHash));
  if (indexed) {
    if (indexed.schemaVersion !== DEVICE_GOVERNANCE_SCHEMA_VERSION
        || indexed.requestHash !== requestHash
        || indexed.deviceId !== deviceId
        || !EVENT_ID_PATTERN.test(String(indexed.eventId || ''))
        || !Number.isSafeInteger(indexed.version) || indexed.version < 1
        || indexed.action !== action) {
      throw new DeviceGovernanceError('DEVICE_GOVERNANCE_REQUEST_INDEX_INVALID', '设备治理请求索引无效', 503);
    }
    const event = normalizeEvent(
      await getJSONStrong(store, governanceEventKey(deviceId, indexed.version, indexed.eventId)),
      { deviceId, requestHash },
    );
    return finishEvent({ store, event, deviceRef: input.deviceRef, duplicate: true });
  }

  const recovered = await findExistingEventForRequest(store, deviceId, requestHash);
  if (recovered) return finishEvent({ store, event: recovered, deviceRef: input.deviceRef, duplicate: true });

  const state = await readEffectiveDeviceGovernance({ store, deviceId });
  const target = nextState(action, state);
  const actorTag = actorTagFor(identity);
  const eventId = eventIdFor(requestHash);
  const event = Object.freeze({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    eventId,
    requestHash,
    deviceId,
    action,
    reasonCode: input.reasonCode,
    actorTag,
    fromVersion: state.version,
    version: state.version + 1,
    previousTrusted: state.trusted,
    previousBlocked: state.blocked,
    trusted: target.trusted,
    blocked: target.blocked,
    createdAt: now,
  });
  const transition = Object.freeze({
    schemaVersion: DEVICE_GOVERNANCE_SCHEMA_VERSION,
    deviceId,
    fromVersion: state.version,
    requestHash,
    eventId,
    action,
    targetTrusted: target.trusted,
    targetBlocked: target.blocked,
    createdAt: now,
  });
  await putImmutableExact(
    store,
    governanceTransitionKey(deviceId, state.version),
    transition,
    'DEVICE_GOVERNANCE_TRANSITION_CONFLICT',
    '设备治理基线已被另一个请求占用',
  );
  await putImmutableExact(
    store,
    governanceEventKey(deviceId, event.version, eventId),
    event,
    'DEVICE_GOVERNANCE_EVENT_CONFLICT',
    '设备治理事件冲突',
  );
  return finishEvent({ store, event, deviceRef: input.deviceRef, duplicate: false });
}

export function isAdminDeviceGovernanceProjectionSafe(value) {
  const forbiddenKeys = new Set([
    'deviceId', 'deviceToken', 'tokenHash', 'requestHash', 'eventId', 'eventKey',
    'transitionKey', 'blobKey', 'secret', 'salt',
  ]);
  const visit = (item, depth = 0) => {
    if (depth > 12) return false;
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) return true;
    if (Array.isArray(item)) return item.every(entry => visit(entry, depth + 1));
    if (!isPlainObject(item)) return false;
    return Object.entries(item).every(([key, entry]) => !forbiddenKeys.has(key) && visit(entry, depth + 1));
  };
  return visit(value);
}
