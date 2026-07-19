import { createHash, timingSafeEqual } from 'node:crypto';
import {
  assertAdminSameOriginRequest,
  readAdminAuthConfig,
} from './admin_auth_v1.js';
import {
  buildPublicSnapshot,
  listValidPublicEvents,
  publishAdminReviewApproval,
} from './auto_approval_engine_v1.js';
import {
  deviceProfileKey,
  deviceTokenIndexKey,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import {
  authenticateDevice,
  hashDeviceToken,
  registerDevice,
} from './device_registration_v1.js';
import {
  deviceRefFor,
  readDeviceGovernanceConfig,
  readEffectiveDeviceGovernance,
} from './device_governance_v1.js';
import {
  buildAdminExportSummary,
  readAdminExportConfig,
} from './admin_export_v1.js';
import {
  listAdminRollbackCandidates,
  readAdminRollbackConfig,
} from './admin_rollback_v1.js';
import {
  buildIdempotencyKey,
  canonicalize,
  computeSubmissionHashes,
  normalizeSubmission,
} from './submission_policy_v1.js';

export const STAGE5DEF_ACCEPTANCE_SCHEMA_VERSION = 1;
export const STAGE5DEF_PUBLIC_STORE_NAME = 'cloud-collab-preview-v1';
export const STAGE5DEF_ADMIN_STORE_NAME = 'cloud-collab-admin-preview-v1';
export const STAGE5DEF_GROUP_ID = 'group_fixture';
export const STAGE5DEF_LIBRARY_ID = 'lib_receive_fixture';
export const STAGE5DEF_SEED_CONFIRMATION = 'SEED_STAGE5DEF_SYNTHETIC_V1';
export const STAGE5DEF_ACCEPTANCE_HEADER = 'x-cloud-stage5def-acceptance-key';
export const STAGE5DEF_SERVICE_NAME = '阶段5DEF联合验收普通单价';
export const STAGE5DEF_FIRST_PRICE = 100;
export const STAGE5DEF_SECOND_PRICE = 120;
export const STAGE5DEF_SEED_TIME = 1_784_500_000_000;
export const STAGE5DEF_MAX_OBJECTS = 2_000;

const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUBMISSION_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUBMISSION_B = 'sub_01JABCDEF0123456789XYZABCE';
const TOKEN_FILL_A = 0x5d;
const TOKEN_FILL_B = 0x5e;
const SEED_MARKER_KEY = normalizeBlobKey('stage5def/seed/v1.json');
const PLACEHOLDER_HASH = 'A'.repeat(43);
const SLOT_MAP = Object.freeze({
  A: Object.freeze({
    deviceId: DEVICE_A,
    submissionId: SUBMISSION_A,
    nickname: '联合验收设备A',
    tokenFill: TOKEN_FILL_A,
  }),
  B: Object.freeze({
    deviceId: DEVICE_B,
    submissionId: SUBMISSION_B,
    nickname: '联合验收设备B',
    tokenFill: TOKEN_FILL_B,
  }),
});

export class Stage5defAcceptanceError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '阶段5D/5E/5F联合验收失败');
    this.name = 'Stage5defAcceptanceError';
    this.code = code || 'STAGE5DEF_ACCEPTANCE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function fixedDigest(value) {
  return createHash('sha256').update(Buffer.from(String(value || ''), 'utf8')).digest();
}

function safeEqual(left, right) {
  return timingSafeEqual(fixedDigest(left), fixedDigest(right));
}

function assertSecret(value, code, label) {
  const text = String(value || '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 32 || bytes > 256) {
    throw new Stage5defAcceptanceError(code, `${label}必须为32至256字节`, 503);
  }
  return text;
}

function assertDistinctSecrets(values) {
  const configured = values.map(value => String(value || '')).filter(Boolean);
  for (let index = 0; index < configured.length; index += 1) {
    for (let right = index + 1; right < configured.length; right += 1) {
      if (safeEqual(configured[index], configured[right])) {
        throw new Stage5defAcceptanceError(
          'STAGE5DEF_ACCEPTANCE_SECRETS_REUSED',
          '联合验收的管理员凭据、设备引用盐值、回滚引用盐值、导出审计盐值和验收密钥必须互不复用',
          503,
        );
      }
    }
  }
}

function assertExactZero(env, names) {
  const enabled = names.filter(name => String(env[name] || '0').trim() !== '0');
  if (enabled.length) {
    throw new Stage5defAcceptanceError(
      'STAGE5DEF_ACCEPTANCE_REQUIRES_OTHER_MUTATIONS_CLOSED',
      '联合验收要求普通写入、自动审核和阶段5C审核写入保持关闭',
      503,
      { enabledCount: enabled.length },
    );
  }
}

export function readStage5defAcceptanceConfig(env = {}) {
  if (String(env.CLOUD_STAGE5DEF_ACCEPTANCE_ENABLED || '').trim() !== '1') {
    throw new Stage5defAcceptanceError('STAGE5DEF_ACCEPTANCE_DISABLED', '阶段5D/5E/5F联合验收未开启', 503);
  }
  if (String(env.CLOUD_STAGE5DEF_CLEANUP_ENABLED || '0').trim() === '1') {
    throw new Stage5defAcceptanceError(
      'STAGE5DEF_ACCEPTANCE_CLEANUP_CONFLICT',
      '联合验收与联合清理不能同时开启',
      503,
    );
  }
  assertExactZero(env, [
    'CLOUD_WRITE_PREVIEW_ENABLED',
    'CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED',
    'CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED',
  ]);

  let adminConfig;
  let governanceConfig;
  let rollbackConfig;
  let exportConfig;
  try {
    adminConfig = readAdminAuthConfig(env);
    governanceConfig = readDeviceGovernanceConfig(env);
    rollbackConfig = readAdminRollbackConfig(env);
    exportConfig = readAdminExportConfig(env);
  } catch (error) {
    throw new Stage5defAcceptanceError(
      'STAGE5DEF_ACCEPTANCE_CONFIG_INVALID',
      '联合验收底层管理员能力配置无效',
      503,
      null,
      error,
    );
  }

  if (String(env.CLOUD_BLOB_STORE_NAME || '').trim() !== STAGE5DEF_PUBLIC_STORE_NAME
      || adminConfig.storeName !== STAGE5DEF_ADMIN_STORE_NAME
      || governanceConfig.storeName !== STAGE5DEF_PUBLIC_STORE_NAME
      || rollbackConfig.storeName !== STAGE5DEF_PUBLIC_STORE_NAME
      || exportConfig.storeName !== STAGE5DEF_PUBLIC_STORE_NAME
      || rollbackConfig.groupId !== STAGE5DEF_GROUP_ID
      || rollbackConfig.libraryId !== STAGE5DEF_LIBRARY_ID
      || exportConfig.groupId !== STAGE5DEF_GROUP_ID
      || exportConfig.libraryId !== STAGE5DEF_LIBRARY_ID) {
    throw new Stage5defAcceptanceError(
      'STAGE5DEF_ACCEPTANCE_SCOPE_INVALID',
      '联合验收必须硬锁两套合成Blob和fixture作用域',
      503,
    );
  }

  const acceptanceKey = assertSecret(
    env.CLOUD_STAGE5DEF_ACCEPTANCE_KEY,
    'STAGE5DEF_ACCEPTANCE_KEY_INVALID',
    '联合验收密钥',
  );
  assertDistinctSecrets([
    acceptanceKey,
    adminConfig.password,
    adminConfig.sessionSecret,
    adminConfig.rateLimitSalt,
    governanceConfig.deviceRefSalt,
    rollbackConfig.rollbackRefSalt,
    exportConfig.auditSalt,
    env.CLOUD_STAGE5DEF_CLEANUP_KEY,
  ]);

  return Object.freeze({
    schemaVersion: STAGE5DEF_ACCEPTANCE_SCHEMA_VERSION,
    acceptanceKey,
    publicOrigin: adminConfig.publicOrigin,
    publicStoreName: STAGE5DEF_PUBLIC_STORE_NAME,
    adminStoreName: STAGE5DEF_ADMIN_STORE_NAME,
    groupId: STAGE5DEF_GROUP_ID,
    libraryId: STAGE5DEF_LIBRARY_ID,
    governanceConfig,
    rollbackConfig,
    exportConfig,
  });
}

export function assertStage5defAcceptanceAccess(request, config, { requireOrigin = true } = {}) {
  assertAdminSameOriginRequest(request, {
    requireOrigin,
    publicOrigin: config?.publicOrigin,
  });
  const supplied = String(request?.headers?.get?.(STAGE5DEF_ACCEPTANCE_HEADER) || '');
  if (Buffer.byteLength(supplied, 'utf8') < 32
      || Buffer.byteLength(supplied, 'utf8') > 256
      || !safeEqual(config?.acceptanceKey, supplied)) {
    throw new Stage5defAcceptanceError(
      'STAGE5DEF_ACCEPTANCE_ACCESS_DENIED',
      '联合验收访问被拒绝',
      403,
    );
  }
  return true;
}

function deterministicToken(fill) {
  return `dt_v1_${Buffer.alloc(32, fill).toString('base64url')}`;
}

function slotConfig(slot) {
  const normalized = String(slot || '').trim().toUpperCase();
  const config = SLOT_MAP[normalized];
  if (!config) {
    throw new Stage5defAcceptanceError('STAGE5DEF_DEVICE_SLOT_INVALID', '联合验收设备槽位无效', 400);
  }
  return Object.freeze({ slot: normalized, ...config });
}

function expectedRegistration(slot) {
  const config = slotConfig(slot);
  const deviceToken = deterministicToken(config.tokenFill);
  return Object.freeze({
    ...config,
    deviceToken,
    tokenHash: hashDeviceToken(deviceToken),
  });
}

async function ensureSyntheticDevice(store, slot) {
  const expected = expectedRegistration(slot);
  const profileKey = deviceProfileKey(expected.deviceId);
  const tokenKey = deviceTokenIndexKey(expected.tokenHash);
  const [profile, tokenIndex] = await Promise.all([
    getJSONStrong(store, profileKey),
    getJSONStrong(store, tokenKey),
  ]);

  if (!profile && !tokenIndex) {
    await registerDevice({
      store,
      input: {
        schemaVersion: 1,
        deviceId: expected.deviceId,
        nickname: expected.nickname,
        clientContext: { appVersion: '8.2.28-stage5def' },
      },
      now: STAGE5DEF_SEED_TIME + (expected.slot === 'A' ? 100 : 200),
      randomBytes: () => Buffer.alloc(32, expected.tokenFill),
    });
  } else if (!profile || !tokenIndex) {
    throw new Stage5defAcceptanceError(
      'STAGE5DEF_DEVICE_PARTIAL_STATE',
      '联合验收设备档案或令牌索引不完整',
      409,
      { slot: expected.slot },
    );
  }

  const storedProfile = await getJSONStrong(store, profileKey);
  const storedIndex = await getJSONStrong(store, tokenKey);
  if (!storedProfile || !storedIndex
      || storedProfile.schemaVersion !== 1
      || storedProfile.deviceId !== expected.deviceId
      || storedProfile.nickname !== expected.nickname
      || storedProfile.tokenHash !== expected.tokenHash
      || storedProfile.lastAppVersion !== '8.2.28-stage5def'
      || storedIndex.schemaVersion !== 1
      || storedIndex.deviceId !== expected.deviceId
      || storedIndex.tokenHash !== expected.tokenHash
      || storedIndex.tokenVersion !== storedProfile.tokenVersion
      || storedIndex.issuedAt !== storedProfile.issuedAt
      || storedIndex.expiresAt !== storedProfile.expiresAt) {
    throw new Stage5defAcceptanceError(
      'STAGE5DEF_DEVICE_STATE_CONFLICT',
      '联合验收设备对象与固定种子不一致',
      409,
      { slot: expected.slot },
    );
  }
  return expected;
}

function buildSyntheticSubmission({ deviceId, submissionId, unitPrice, createdAt }) {
  const draft = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId: STAGE5DEF_GROUP_ID,
    libraryId: STAGE5DEF_LIBRARY_ID,
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: createdAt,
    businessKey: `bk_v1_${PLACEHOLDER_HASH}`,
    contentHash: `ch_v1_${PLACEHOLDER_HASH}`,
    idempotencyKey: buildIdempotencyKey(deviceId, submissionId),
    payload: {
      serviceName: STAGE5DEF_SERVICE_NAME,
      settleType: 'round',
      unitPrice,
    },
    clientContext: {
      appVersion: '8.2.28-stage5def',
      projectionSpecVersion: 1,
      queueSchemaVersion: 1,
    },
  };
  const computed = computeSubmissionHashes(draft);
  return normalizeSubmission({
    ...draft,
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    idempotencyKey: computed.idempotencyKey,
  });
}

async function putSeedMarker(store) {
  const marker = Object.freeze({
    schemaVersion: STAGE5DEF_ACCEPTANCE_SCHEMA_VERSION,
    fixtureId: 'stage5def-v1',
    groupId: STAGE5DEF_GROUP_ID,
    libraryId: STAGE5DEF_LIBRARY_ID,
    serviceName: STAGE5DEF_SERVICE_NAME,
    firstPrice: STAGE5DEF_FIRST_PRICE,
    secondPrice: STAGE5DEF_SECOND_PRICE,
    deviceSlots: Object.freeze(['A', 'B']),
  });
  try {
    await putJSONOnlyIfNew(store, SEED_MARKER_KEY, marker);
  } catch (error) {
    if (error?.code !== 'BLOB_ALREADY_EXISTS') throw error;
    const existing = await getJSONStrong(store, SEED_MARKER_KEY);
    if (!existing || canonicalize(existing) !== canonicalize(marker)) {
      throw new Stage5defAcceptanceError(
        'STAGE5DEF_SEED_MARKER_CONFLICT',
        '联合验收种子标记与固定定义不一致',
        409,
        null,
        error,
      );
    }
  }
  return marker;
}

export async function seedStage5defAcceptance({ store, config } = {}) {
  if (!config || config.groupId !== STAGE5DEF_GROUP_ID || config.libraryId !== STAGE5DEF_LIBRARY_ID) {
    throw new Stage5defAcceptanceError('STAGE5DEF_ACCEPTANCE_SCOPE_INVALID', '联合验收配置无效', 503);
  }
  await putSeedMarker(store);
  const [deviceA, deviceB] = await Promise.all([
    ensureSyntheticDevice(store, 'A'),
    ensureSyntheticDevice(store, 'B'),
  ]);

  const firstSubmission = buildSyntheticSubmission({
    deviceId: deviceA.deviceId,
    submissionId: deviceA.submissionId,
    unitPrice: STAGE5DEF_FIRST_PRICE,
    createdAt: STAGE5DEF_SEED_TIME + 1_000,
  });
  const first = await publishAdminReviewApproval({
    store,
    submission: firstSubmission,
    baseline: { approvedVersion: 0, contentHash: null, unitPrice: null },
    approvalMode: 'admin_approved',
    evidence: [{ deviceId: deviceA.deviceId, submissionId: deviceA.submissionId }],
    now: STAGE5DEF_SEED_TIME + 1_000,
  });

  const secondSubmission = buildSyntheticSubmission({
    deviceId: deviceB.deviceId,
    submissionId: deviceB.submissionId,
    unitPrice: STAGE5DEF_SECOND_PRICE,
    createdAt: STAGE5DEF_SEED_TIME + 2_000,
  });
  const second = await publishAdminReviewApproval({
    store,
    submission: secondSubmission,
    baseline: {
      approvedVersion: first.event.version,
      contentHash: first.event.contentHash,
      unitPrice: STAGE5DEF_FIRST_PRICE,
    },
    approvalMode: 'admin_approved',
    evidence: [{ deviceId: deviceB.deviceId, submissionId: deviceB.submissionId }],
    now: STAGE5DEF_SEED_TIME + 2_000,
  });

  const snapshot = await buildPublicSnapshot({
    store,
    groupId: STAGE5DEF_GROUP_ID,
    libraryId: STAGE5DEF_LIBRARY_ID,
    now: STAGE5DEF_SEED_TIME + 3_000,
  });
  const record = snapshot.records.find(item => item.businessKey === first.event.businessKey);
  if (!record || ![STAGE5DEF_FIRST_PRICE, STAGE5DEF_SECOND_PRICE].includes(record.payload?.unitPrice)) {
    throw new Stage5defAcceptanceError('STAGE5DEF_SEED_SNAPSHOT_INVALID', '联合验收公共快照与种子不一致', 503);
  }

  return Object.freeze({
    schemaVersion: STAGE5DEF_ACCEPTANCE_SCHEMA_VERSION,
    seeded: true,
    groupId: STAGE5DEF_GROUP_ID,
    libraryId: STAGE5DEF_LIBRARY_ID,
    devices: Object.freeze([
      Object.freeze({ slot: 'A', deviceRef: deviceRefFor(deviceA.deviceId, config.governanceConfig.deviceRefSalt) }),
      Object.freeze({ slot: 'B', deviceRef: deviceRefFor(deviceB.deviceId, config.governanceConfig.deviceRefSalt) }),
    ]),
    firstEventVersion: first.event.version,
    secondEventVersion: second.event.version,
    publicVersion: snapshot.publicVersion,
    currentUnitPrice: record.payload.unitPrice,
  });
}

async function listKeysStrong(store) {
  if (!store || typeof store.list !== 'function') {
    throw new Stage5defAcceptanceError('STAGE5DEF_LIST_UNAVAILABLE', '联合验收需要Blob强一致列举能力', 503);
  }
  let result;
  try {
    result = await store.list({ consistency: 'strong' });
  } catch (error) {
    throw new Stage5defAcceptanceError('STAGE5DEF_LIST_FAILED', '联合验收强一致列举Blob失败', 503, null, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > STAGE5DEF_MAX_OBJECTS) {
    throw new Stage5defAcceptanceError('STAGE5DEF_OBJECT_LIMIT_EXCEEDED', '联合验收对象数量超过安全上限', 409);
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new Stage5defAcceptanceError('STAGE5DEF_OBJECT_LIST_INVALID', '联合验收Blob列举结果无效', 503);
  }
  return keys.sort();
}

function keySetDigest(keys) {
  return createHash('sha256').update([...keys].sort().join('\n'), 'utf8').digest('base64url');
}

function auditCounts(keys) {
  return Object.freeze({
    governance: keys.filter(key => /^audit\/[0-9]{4}\/(?:0[1-9]|1[0-2])\/dge_v1_[A-Za-z0-9_-]{43}\.json$/.test(key)).length,
    rollback: keys.filter(key => /^audit\/[0-9]{4}\/(?:0[1-9]|1[0-2])\/rbau_v1_[A-Za-z0-9_-]{43}\.json$/.test(key)).length,
    export: keys.filter(key => /^audit\/[0-9]{4}\/(?:0[1-9]|1[0-2])\/exau_v1_[A-Za-z0-9_-]{43}\.json$/.test(key)).length,
  });
}

export async function inspectStage5defAcceptance({ store, config, now = Date.now() } = {}) {
  const [events, snapshot, stateA, stateB, rollbackCandidates, exportSummary, keys, marker] = await Promise.all([
    listValidPublicEvents({ store, libraryId: STAGE5DEF_LIBRARY_ID }),
    buildPublicSnapshot({ store, groupId: STAGE5DEF_GROUP_ID, libraryId: STAGE5DEF_LIBRARY_ID, now }),
    readEffectiveDeviceGovernance({ store, deviceId: DEVICE_A }),
    readEffectiveDeviceGovernance({ store, deviceId: DEVICE_B }),
    listAdminRollbackCandidates({ store, config: config.rollbackConfig }),
    buildAdminExportSummary({ store, config: config.exportConfig, now }),
    listKeysStrong(store),
    getJSONStrong(store, SEED_MARKER_KEY),
  ]);
  const record = snapshot.records.find(item => item.payload?.serviceName === STAGE5DEF_SERVICE_NAME) || null;
  const audits = auditCounts(keys);
  const seedMarkerValid = Boolean(marker && marker.fixtureId === 'stage5def-v1'
    && marker.groupId === STAGE5DEF_GROUP_ID
    && marker.libraryId === STAGE5DEF_LIBRARY_ID);
  const governanceComplete = stateA.version >= 2 && stateA.trusted === false && stateA.blocked === false
    && stateB.version >= 2 && stateB.trusted === false && stateB.blocked === false;
  const rollbackComplete = snapshot.publicVersion >= 3
    && record?.payload?.unitPrice === STAGE5DEF_FIRST_PRICE
    && audits.rollback >= 1;
  const exportComplete = audits.export >= 1
    && exportSummary.publicVersion === snapshot.publicVersion;
  return Object.freeze({
    schemaVersion: STAGE5DEF_ACCEPTANCE_SCHEMA_VERSION,
    seedMarkerValid,
    eventCount: events.length,
    publicVersion: snapshot.publicVersion,
    recordCount: snapshot.records.length,
    currentUnitPrice: record?.payload?.unitPrice ?? null,
    rollbackCandidateCount: rollbackCandidates.count,
    exportPackageId: exportSummary.packageId,
    exportFileCount: exportSummary.fileCount,
    publicObjectCount: keys.length,
    publicKeySetDigest: keySetDigest(keys),
    audits,
    devices: Object.freeze([
      Object.freeze({
        slot: 'A',
        deviceRef: deviceRefFor(DEVICE_A, config.governanceConfig.deviceRefSalt),
        trusted: stateA.trusted,
        blocked: stateA.blocked,
        governanceVersion: stateA.version,
      }),
      Object.freeze({
        slot: 'B',
        deviceRef: deviceRefFor(DEVICE_B, config.governanceConfig.deviceRefSalt),
        trusted: stateB.trusted,
        blocked: stateB.blocked,
        governanceVersion: stateB.version,
      }),
    ]),
    governanceComplete,
    rollbackComplete,
    exportComplete,
    readyForCleanup: seedMarkerValid && governanceComplete && rollbackComplete && exportComplete,
  });
}

export async function checkStage5defDeviceAuthentication({ store, config, slot, now = Date.now() } = {}) {
  const expected = expectedRegistration(slot);
  const identity = await authenticateDevice({
    store,
    authorization: `Bearer ${expected.deviceToken}`,
    now,
  });
  return Object.freeze({
    schemaVersion: STAGE5DEF_ACCEPTANCE_SCHEMA_VERSION,
    authenticated: true,
    slot: expected.slot,
    deviceRef: deviceRefFor(expected.deviceId, config.governanceConfig.deviceRefSalt),
    nicknameTag: identity.nicknameTag,
    expiresAt: identity.expiresAt,
  });
}

export function isStage5defAcceptanceProjectionSafe(value) {
  const forbiddenKeys = new Set([
    'deviceId', 'deviceToken', 'tokenHash', 'submissionId', 'submissionIds', 'approvalId',
    'eventKey', 'snapshotKey', 'businessKey', 'contentHash', 'requestHash', 'requestToken',
    'rollbackId', 'auditId', 'exportId', 'actorTag', 'blobKey', 'secret', 'salt',
  ]);
  const visit = (item, depth = 0) => {
    if (depth > 12) return false;
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
      if (typeof item === 'string' && (item.includes('public/') || item.includes('audit/') || item.includes('devices/'))) return false;
      return true;
    }
    if (Array.isArray(item)) return item.every(entry => visit(entry, depth + 1));
    if (!isPlainObject(item)) return false;
    return Object.entries(item).every(([key, entry]) => !forbiddenKeys.has(key) && visit(entry, depth + 1));
  };
  return visit(value);
}
