import { createHash, timingSafeEqual } from 'node:crypto';
import { assertAdminSameOriginRequest } from './admin_auth_v1.js';
import {
  deviceProfileKey,
  deviceTokenIndexKey,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import {
  hashDeviceToken,
  registerDevice,
} from './device_registration_v1.js';
import { buildUnifiedSensitivePublicSnapshot } from './sensitive_public_engine_v1.js';

export const STAGE5G6A6B_ACCEPTANCE_SCHEMA_VERSION = 1;
export const STAGE5G6A6B_PUBLIC_STORE = 'cloud-collab-preview-v1';
export const STAGE5G6A6B_ADMIN_STORE = 'cloud-collab-admin-preview-v1';
export const STAGE5G6A6B_GROUP_ID = 'group_fixture';
export const STAGE5G6A6B_LIBRARY_ID = 'lib_receive_fixture';
export const STAGE5G6A6B_ACCEPTANCE_HEADER = 'x-cloud-stage5g6a6b-acceptance-key';
export const STAGE5G6A6B_SEED_CONFIRMATION = 'SEED_STAGE5G6A6B_SYNTHETIC_V1';
export const STAGE5G6A6B_SEED_MARKER_KEY = normalizeBlobKey('stage5g6a6b/seed/v1.json');

const DEVICE_A = 'dev_01JSTAGE5G6A6B000000000001';
const DEVICE_B = 'dev_01JSTAGE5G6A6B000000000002';
const TOKEN_FILL_A = 0x6a;
const TOKEN_FILL_B = 0x6b;
const DEVICE_SLOTS = Object.freeze([
  Object.freeze({ slot: 'A', deviceId: DEVICE_A, nickname: '联合验收设备A', tokenFill: TOKEN_FILL_A }),
  Object.freeze({ slot: 'B', deviceId: DEVICE_B, nickname: '联合验收设备B', tokenFill: TOKEN_FILL_B }),
]);

export class Stage5g6a6bAcceptanceError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '阶段5G/6A/6B联合验收失败');
    this.name = 'Stage5g6a6bAcceptanceError';
    this.code = code || 'STAGE5G6A6B_ACCEPTANCE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function fixedDigest(value) {
  return createHash('sha256').update(Buffer.from(String(value || ''), 'utf8')).digest();
}

function safeEqual(left, right) {
  return timingSafeEqual(fixedDigest(left), fixedDigest(right));
}

function secretBytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function assertSecret(value, code, label) {
  const text = String(value || '');
  const bytes = secretBytes(text);
  if (bytes < 32 || bytes > 256) {
    throw new Stage5g6a6bAcceptanceError(code, `${label}必须为32至256字节`, 503);
  }
  return text;
}

function assertExactOne(env, names) {
  const disabled = names.filter(name => String(env[name] || '0').trim() !== '1');
  if (disabled.length) {
    throw new Stage5g6a6bAcceptanceError(
      'STAGE5G6A6B_REQUIRED_CAPABILITY_DISABLED',
      '联合验收要求普通写入、普通类型、敏感协议、敏感审核和管理员审核能力全部开启',
      503,
      { disabledCount: disabled.length },
    );
  }
}

function assertDistinctSecrets(values) {
  const configured = values.map(value => String(value || '')).filter(Boolean);
  for (let left = 0; left < configured.length; left += 1) {
    for (let right = left + 1; right < configured.length; right += 1) {
      if (safeEqual(configured[left], configured[right])) {
        throw new Stage5g6a6bAcceptanceError(
          'STAGE5G6A6B_ACCEPTANCE_SECRETS_REUSED',
          '联合验收密钥、清理密钥、公共预览凭据和管理员凭据必须互不复用',
          503,
        );
      }
    }
  }
}

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

export function readStage5g6a6bAcceptanceConfig(env = {}) {
  if (String(env.CLOUD_STAGE5G6A6B_ACCEPTANCE_ENABLED || '').trim() !== '1') {
    throw new Stage5g6a6bAcceptanceError(
      'STAGE5G6A6B_ACCEPTANCE_DISABLED',
      '阶段5G/6A/6B联合验收未开启',
      503,
    );
  }
  if (String(env.CLOUD_STAGE5G6A6B_CLEANUP_ENABLED || '0').trim() === '1') {
    throw new Stage5g6a6bAcceptanceError(
      'STAGE5G6A6B_ACCEPTANCE_CLEANUP_CONFLICT',
      '联合验收与联合清理不能同时开启',
      503,
    );
  }
  assertExactOne(env, [
    'CLOUD_WRITE_PREVIEW_ENABLED',
    'CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED',
    'CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED',
    'CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED',
    'CLOUD_ADMIN_PREVIEW_ENABLED',
    'CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED',
    'CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED',
  ]);

  const storeChecks = [
    env.CLOUD_BLOB_STORE_NAME,
    env.CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME,
    env.CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME,
    env.CLOUD_SENSITIVE_REVIEW_BLOB_STORE_NAME,
    env.CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME,
  ];
  if (storeChecks.some(value => String(value || '').trim() !== STAGE5G6A6B_PUBLIC_STORE)
      || String(env.CLOUD_ADMIN_BLOB_STORE_NAME || '').trim() !== STAGE5G6A6B_ADMIN_STORE) {
    throw new Stage5g6a6bAcceptanceError(
      'STAGE5G6A6B_ACCEPTANCE_STORE_INVALID',
      '联合验收必须硬锁公共与管理员合成Blob',
      503,
    );
  }

  const groupChecks = [
    env.CLOUD_WRITE_ALLOWED_GROUP_ID,
    env.CLOUD_ORDINARY_TYPES_ALLOWED_GROUP_ID,
    env.CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID,
    env.CLOUD_SENSITIVE_REVIEW_ALLOWED_GROUP_ID,
    env.CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID,
  ];
  const libraryChecks = [
    env.CLOUD_WRITE_ALLOWED_LIBRARY_ID,
    env.CLOUD_ORDINARY_TYPES_ALLOWED_LIBRARY_ID,
    env.CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID,
    env.CLOUD_SENSITIVE_REVIEW_ALLOWED_LIBRARY_ID,
    env.CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID,
  ];
  if (groupChecks.some(value => normalized(value) !== STAGE5G6A6B_GROUP_ID)
      || libraryChecks.some(value => normalized(value) !== STAGE5G6A6B_LIBRARY_ID)) {
    throw new Stage5g6a6bAcceptanceError(
      'STAGE5G6A6B_ACCEPTANCE_SCOPE_INVALID',
      '联合验收只能访问固定fixture作用域',
      503,
    );
  }

  const acceptanceKey = assertSecret(
    env.CLOUD_STAGE5G6A6B_ACCEPTANCE_KEY,
    'STAGE5G6A6B_ACCEPTANCE_KEY_INVALID',
    '联合验收密钥',
  );
  assertDistinctSecrets([
    acceptanceKey,
    env.CLOUD_STAGE5G6A6B_CLEANUP_KEY,
    env.CLOUD_WRITE_PREVIEW_KEY,
    env.CLOUD_RATE_LIMIT_SALT,
    env.CLOUD_ADMIN_PASSWORD,
    env.CLOUD_ADMIN_SESSION_SECRET,
    env.CLOUD_ADMIN_RATE_LIMIT_SALT,
  ]);

  const publicOrigin = String(env.CLOUD_ADMIN_PUBLIC_ORIGIN || '').trim();
  if (!/^https:\/\//i.test(publicOrigin)) {
    throw new Stage5g6a6bAcceptanceError(
      'STAGE5G6A6B_ACCEPTANCE_ORIGIN_INVALID',
      '联合验收必须配置HTTPS管理员同源地址',
      503,
    );
  }

  return Object.freeze({
    schemaVersion: STAGE5G6A6B_ACCEPTANCE_SCHEMA_VERSION,
    acceptanceKey,
    publicOrigin,
    publicStoreName: STAGE5G6A6B_PUBLIC_STORE,
    adminStoreName: STAGE5G6A6B_ADMIN_STORE,
    groupId: STAGE5G6A6B_GROUP_ID,
    libraryId: STAGE5G6A6B_LIBRARY_ID,
  });
}

export function assertStage5g6a6bAcceptanceAccess(request, config, { requireOrigin = true } = {}) {
  assertAdminSameOriginRequest(request, { requireOrigin, publicOrigin: config?.publicOrigin });
  const supplied = String(request?.headers?.get?.(STAGE5G6A6B_ACCEPTANCE_HEADER) || '');
  if (secretBytes(supplied) < 32 || secretBytes(supplied) > 256 || !safeEqual(config?.acceptanceKey, supplied)) {
    throw new Stage5g6a6bAcceptanceError(
      'STAGE5G6A6B_ACCEPTANCE_ACCESS_DENIED',
      '联合验收访问被拒绝',
      403,
    );
  }
  return true;
}

function deterministicToken(fill) {
  return `dt_v1_${Buffer.alloc(32, fill).toString('base64url')}`;
}

async function readDeviceState(store, slot) {
  const deviceToken = deterministicToken(slot.tokenFill);
  const tokenHash = hashDeviceToken(deviceToken);
  const profile = await getJSONStrong(store, deviceProfileKey(slot.deviceId));
  const index = await getJSONStrong(store, deviceTokenIndexKey(tokenHash));
  if (!profile && !index) return null;
  if (!profile || !index
      || profile.deviceId !== slot.deviceId
      || profile.tokenHash !== tokenHash
      || index.deviceId !== slot.deviceId
      || index.tokenHash !== tokenHash
      || profile.tokenVersion !== index.tokenVersion) {
    throw new Stage5g6a6bAcceptanceError(
      'STAGE5G6A6B_DEVICE_STATE_CONFLICT',
      '联合验收合成设备状态与固定身份不一致',
      409,
      { slot: slot.slot },
    );
  }
  return Object.freeze({
    slot: slot.slot,
    deviceId: slot.deviceId,
    deviceToken,
    tokenVersion: index.tokenVersion,
    expiresAt: index.expiresAt,
  });
}

async function ensureDevice(store, slot, now) {
  const existing = await readDeviceState(store, slot);
  if (existing) return existing;
  const result = await registerDevice({
    store,
    input: {
      schemaVersion: 1,
      deviceId: slot.deviceId,
      nickname: slot.nickname,
      clientContext: { appVersion: '8.2.28' },
    },
    now,
    randomBytes: size => {
      if (size !== 32) throw new Stage5g6a6bAcceptanceError('STAGE5G6A6B_TOKEN_SIZE_INVALID', '合成令牌长度无效', 500);
      return Buffer.alloc(32, slot.tokenFill);
    },
  });
  return Object.freeze({
    slot: slot.slot,
    deviceId: result.deviceId,
    deviceToken: result.deviceToken,
    tokenVersion: result.tokenVersion,
    expiresAt: result.expiresAt,
  });
}

function seedMarker(now) {
  return Object.freeze({
    schemaVersion: STAGE5G6A6B_ACCEPTANCE_SCHEMA_VERSION,
    kind: 'stage5g6a6b_acceptance_seed',
    groupId: STAGE5G6A6B_GROUP_ID,
    libraryId: STAGE5G6A6B_LIBRARY_ID,
    deviceIds: Object.freeze(DEVICE_SLOTS.map(item => item.deviceId)),
    createdAt: now,
  });
}

export async function seedStage5g6a6bAcceptance({ store, confirmation, now = Date.now() } = {}) {
  if (confirmation !== STAGE5G6A6B_SEED_CONFIRMATION) {
    throw new Stage5g6a6bAcceptanceError(
      'STAGE5G6A6B_SEED_CONFIRMATION_REQUIRED',
      '缺少联合验收合成种子的明确确认',
      400,
    );
  }
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Stage5g6a6bAcceptanceError('STAGE5G6A6B_SERVER_TIME_INVALID', '联合验收服务器时间无效', 500);
  }
  const devices = [];
  for (const slot of DEVICE_SLOTS) devices.push(await ensureDevice(store, slot, now));

  const proposed = seedMarker(now);
  let marker = proposed;
  let duplicate = false;
  try {
    await putJSONOnlyIfNew(store, STAGE5G6A6B_SEED_MARKER_KEY, proposed);
  } catch (_) {
    marker = await getJSONStrong(store, STAGE5G6A6B_SEED_MARKER_KEY);
    if (!marker || marker.schemaVersion !== proposed.schemaVersion
        || marker.kind !== proposed.kind
        || marker.groupId !== proposed.groupId
        || marker.libraryId !== proposed.libraryId
        || JSON.stringify(marker.deviceIds) !== JSON.stringify(proposed.deviceIds)) {
      throw new Stage5g6a6bAcceptanceError(
        'STAGE5G6A6B_SEED_CONFLICT',
        '联合验收种子对象已存在但内容不一致',
        409,
      );
    }
    duplicate = true;
  }

  return Object.freeze({
    schemaVersion: 1,
    duplicate,
    groupId: STAGE5G6A6B_GROUP_ID,
    libraryId: STAGE5G6A6B_LIBRARY_ID,
    markerCreatedAt: marker.createdAt,
    devices: Object.freeze(devices),
  });
}

async function listKeys(store, prefix) {
  if (!store || typeof store.list !== 'function') {
    throw new Stage5g6a6bAcceptanceError('STAGE5G6A6B_BLOB_LIST_REQUIRED', '联合验收状态需要Blob list能力', 503);
  }
  const result = await store.list({ prefix, consistency: 'strong' });
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new Stage5g6a6bAcceptanceError('STAGE5G6A6B_BLOB_LIST_INVALID', '联合验收Blob列举结果无效', 503);
  }
  return keys.sort();
}

export async function inspectStage5g6a6bAcceptance({ store, now = Date.now() } = {}) {
  const marker = await getJSONStrong(store, STAGE5G6A6B_SEED_MARKER_KEY);
  const deviceStates = [];
  for (const slot of DEVICE_SLOTS) deviceStates.push(await readDeviceState(store, slot));
  const submissionKeys = await listKeys(store, `submissions/${STAGE5G6A6B_LIBRARY_ID}/pending/`);
  let ordinaryPending = 0;
  let sensitivePending = 0;
  for (const key of submissionKeys) {
    const candidate = await getJSONStrong(store, key);
    if (candidate?.candidateKind === 'sensitive_review') sensitivePending += 1;
    else if (candidate) ordinaryPending += 1;
  }
  const snapshot = await buildUnifiedSensitivePublicSnapshot({
    store,
    groupId: STAGE5G6A6B_GROUP_ID,
    libraryId: STAGE5G6A6B_LIBRARY_ID,
    now,
  });
  const publicEventKeys = await listKeys(store, `public/${STAGE5G6A6B_LIBRARY_ID}/`);
  const reviewKeys = await listKeys(store, `reviews/${STAGE5G6A6B_LIBRARY_ID}/`);
  return Object.freeze({
    schemaVersion: 1,
    seeded: Boolean(marker),
    registeredDeviceCount: deviceStates.filter(Boolean).length,
    ordinaryPendingCount: ordinaryPending,
    sensitivePendingCount: sensitivePending,
    publicVersion: snapshot.publicVersion,
    recordCount: snapshot.records.length,
    tombstoneCount: snapshot.tombstones.length,
    publicObjectCount: publicEventKeys.length,
    reviewObjectCount: reviewKeys.length,
    fixtureScope: Object.freeze({ groupId: STAGE5G6A6B_GROUP_ID, libraryId: STAGE5G6A6B_LIBRARY_ID }),
  });
}
