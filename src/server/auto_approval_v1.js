import { createHash } from 'node:crypto';
import {
  BlobRepositoryError,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import {
  canonicalize,
  evaluateExactPriceCandidate,
  normalizeSubmission,
} from './submission_policy_v1.js';

export const AUTO_APPROVAL_SCHEMA_VERSION = 1;
export const PUBLIC_EVENT_SCHEMA_VERSION = 1;
export const PUBLIC_SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_EVENT_RESERVATION_ATTEMPTS = 64;

const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const APPROVAL_ID_PATTERN = /^ap_v1_[A-Za-z0-9_-]{43}$/;
const EVENT_VERSION_PATTERN = /^([0-9]{12})\.json$/;
const MAX_PUBLIC_VERSION = 999_999_999_999;

export class AutoApprovalError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '自动审核处理失败');
    this.name = 'AutoApprovalError';
    this.code = code || 'AUTO_APPROVAL_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('base64url');
}

function assertSafeTime(now) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new AutoApprovalError('INVALID_SERVER_TIME', '服务器时间无效', 500);
  }
  return now;
}

function assertStoreList(store) {
  if (!store || typeof store.list !== 'function') {
    throw new AutoApprovalError('BLOB_LIST_UNAVAILABLE', '自动审核需要Blob list能力', 500);
  }
  return store;
}

async function listKeysStrong(store, prefix) {
  assertStoreList(store);
  const normalizedPrefix = normalizeBlobKey(prefix);
  let result;
  try {
    result = await store.list({ prefix: normalizedPrefix, consistency: 'strong' });
  } catch (error) {
    throw new AutoApprovalError('BLOB_LIST_FAILED', '强一致列举Blob失败', 503, { prefix: normalizedPrefix }, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new AutoApprovalError('INVALID_BLOB_LIST', 'Blob列举结果包含空Key或重复Key', 503, { prefix: normalizedPrefix });
  }
  return keys.sort();
}

function ignoreAlreadyExists(error) {
  return error instanceof BlobRepositoryError && error.code === 'BLOB_ALREADY_EXISTS';
}

function padVersion(version) {
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_PUBLIC_VERSION) {
    throw new AutoApprovalError('INVALID_PUBLIC_VERSION', '公共版本超出协议范围', 500, { version });
  }
  return String(version).padStart(12, '0');
}

export function confirmationPrefix(libraryId, businessKey) {
  return normalizeBlobKey(`submissions/${libraryId}/matches/${businessKey}/`);
}

export function confirmationMarkerKey(submission) {
  return normalizeBlobKey(
    `${confirmationPrefix(submission.libraryId, submission.businessKey)}${submission.contentHash}/${submission.deviceId}.json`,
  );
}

export function trustedDeviceKey(deviceId) {
  return normalizeBlobKey(`devices/trusted/${deviceId}.json`);
}

export function reviewMarkerKey(libraryId, businessKey, contentHash) {
  return normalizeBlobKey(`reviews/${libraryId}/pending/${businessKey}/${contentHash}.json`);
}

export function approvalIdFor(submission) {
  const normalized = normalizeSubmission(submission);
  return `ap_v1_${sha256Base64Url(canonicalize({
    schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
    groupId: normalized.groupId,
    libraryId: normalized.libraryId,
    businessKey: normalized.businessKey,
    contentHash: normalized.contentHash,
  }))}`;
}

export function approvalIndexKey(libraryId, approvalId) {
  if (!APPROVAL_ID_PATTERN.test(String(approvalId || ''))) {
    throw new AutoApprovalError('INVALID_APPROVAL_ID', '批准ID格式无效', 500);
  }
  return normalizeBlobKey(`public/${libraryId}/approvals/${approvalId}.json`);
}

export function publicEventPrefix(libraryId) {
  return normalizeBlobKey(`public/${libraryId}/events/`);
}

export function publicEventKey(libraryId, version) {
  return normalizeBlobKey(`${publicEventPrefix(libraryId)}${padVersion(version)}.json`);
}

export function publicSnapshotKey(libraryId, version) {
  return normalizeBlobKey(`public/${libraryId}/snapshots/${padVersion(version)}.json`);
}

function assertStoredCandidate(candidate) {
  if (!candidate || candidate.schemaVersion !== 1 || !candidate.submission) {
    throw new AutoApprovalError('INVALID_STORED_CANDIDATE', '候选记录结构无效', 500);
  }
  const submission = normalizeSubmission(candidate.submission);
  if (candidate.status !== 'waiting_confirmation') {
    throw new AutoApprovalError('INVALID_CANDIDATE_STATUS', '自动审核只处理waiting_confirmation候选', 409, {
      status: candidate.status,
      submissionId: submission.submissionId,
    });
  }
  return submission;
}

async function ensureConfirmationMarker(store, candidate, submission) {
  const key = confirmationMarkerKey(submission);
  const marker = Object.freeze({
    schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    businessKey: submission.businessKey,
    contentHash: submission.contentHash,
    deviceId: submission.deviceId,
    submissionId: submission.submissionId,
    idempotencyKey: submission.idempotencyKey,
    receivedAt: candidate.receivedAt,
    authenticatedTokenVersion: candidate.authenticatedTokenVersion,
  });
  try {
    await putJSONOnlyIfNew(store, key, marker);
    return marker;
  } catch (error) {
    if (!ignoreAlreadyExists(error)) throw error;
    const existing = await getJSONStrong(store, key);
    if (!existing || existing.deviceId !== submission.deviceId || existing.contentHash !== submission.contentHash) {
      throw new AutoApprovalError('INVALID_CONFIRMATION_MARKER', '设备确认标记与当前候选不一致', 500, { key }, error);
    }
    return existing;
  }
}

function parseConfirmationKey(prefix, key) {
  if (!key.startsWith(prefix)) return null;
  const relative = key.slice(prefix.length);
  const parts = relative.split('/');
  if (parts.length !== 2 || !parts[1].endsWith('.json')) return null;
  const contentHash = parts[0];
  const deviceId = parts[1].slice(0, -5);
  if (!CONTENT_HASH_PATTERN.test(contentHash) || !DEVICE_ID_PATTERN.test(deviceId)) return null;
  return { contentHash, deviceId, key };
}

async function collectBusinessConfirmations(store, submission) {
  const prefix = confirmationPrefix(submission.libraryId, submission.businessKey);
  const keys = await listKeysStrong(store, prefix);
  const byContentHash = new Map();
  for (const key of keys) {
    const parsed = parseConfirmationKey(prefix, key);
    if (!parsed) {
      throw new AutoApprovalError('INVALID_CONFIRMATION_KEY', '候选确认目录包含不符合协议的Key', 500, { key });
    }
    const marker = await getJSONStrong(store, key);
    if (!marker || marker.contentHash !== parsed.contentHash || marker.deviceId !== parsed.deviceId) {
      throw new AutoApprovalError('INVALID_CONFIRMATION_MARKER', '候选确认标记内容无效', 500, { key });
    }
    if (!byContentHash.has(parsed.contentHash)) byContentHash.set(parsed.contentHash, new Map());
    byContentHash.get(parsed.contentHash).set(parsed.deviceId, marker);
  }
  return byContentHash;
}

async function readTrustedDevice(store, deviceId) {
  const record = await getJSONStrong(store, trustedDeviceKey(deviceId));
  if (!record) return false;
  if (record.schemaVersion !== 1 || record.deviceId !== deviceId || typeof record.trusted !== 'boolean') {
    throw new AutoApprovalError('INVALID_TRUSTED_DEVICE_RECORD', '可信设备记录结构无效', 500, { deviceId });
  }
  return record.trusted === true && (record.revokedAt === null || record.revokedAt === undefined);
}

function eventVersionFromKey(prefix, key) {
  if (!key.startsWith(prefix)) return null;
  const match = EVENT_VERSION_PATTERN.exec(key.slice(prefix.length));
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

function assertApprovalIndex(index, expectedApprovalId = null) {
  if (!index || index.schemaVersion !== AUTO_APPROVAL_SCHEMA_VERSION
      || !APPROVAL_ID_PATTERN.test(String(index.approvalId || ''))
      || !Number.isSafeInteger(index.version) || index.version < 1
      || typeof index.eventKey !== 'string') {
    throw new AutoApprovalError('INVALID_APPROVAL_INDEX', '批准索引结构无效', 500);
  }
  if (expectedApprovalId && index.approvalId !== expectedApprovalId) {
    throw new AutoApprovalError('APPROVAL_INDEX_MISMATCH', '批准索引与目标批准ID不一致', 500);
  }
  return index;
}

function assertPublicEvent(event, key, version) {
  if (!event || event.schemaVersion !== PUBLIC_EVENT_SCHEMA_VERSION
      || event.version !== version
      || event.eventKey !== key
      || !APPROVAL_ID_PATTERN.test(String(event.approvalId || ''))
      || !BUSINESS_KEY_PATTERN.test(String(event.businessKey || ''))
      || !CONTENT_HASH_PATTERN.test(String(event.contentHash || ''))
      || event.dataType !== 'exact_price'
      || event.operation !== 'upsert') {
    throw new AutoApprovalError('INVALID_PUBLIC_EVENT', '公共批准事件结构无效', 500, { key, version });
  }
  return event;
}

export async function listValidPublicEvents({ store, libraryId } = {}) {
  const prefix = publicEventPrefix(libraryId);
  const keys = await listKeysStrong(store, prefix);
  const events = [];
  for (const key of keys) {
    const version = eventVersionFromKey(prefix, key);
    if (version === null) {
      throw new AutoApprovalError('INVALID_PUBLIC_EVENT_KEY', '公共事件目录包含不符合协议的Key', 500, { key });
    }
    const event = assertPublicEvent(await getJSONStrong(store, key), key, version);
    const index = await getJSONStrong(store, approvalIndexKey(libraryId, event.approvalId));
    if (!index) continue;
    assertApprovalIndex(index, event.approvalId);
    if (index.version === version && index.eventKey === key) events.push(event);
  }
  return events.sort((left, right) => left.version - right.version);
}

export async function buildPublicSnapshot({ store, groupId, libraryId, now = Date.now() } = {}) {
  assertSafeTime(now);
  const events = await listValidPublicEvents({ store, libraryId });
  const records = new Map();
  for (const event of events) {
    if (event.groupId !== groupId || event.libraryId !== libraryId) {
      throw new AutoApprovalError('PUBLIC_EVENT_SCOPE_MISMATCH', '公共事件作用域与目标价格库不一致', 500, {
        eventKey: event.eventKey,
      });
    }
    records.set(event.businessKey, Object.freeze({
      businessKey: event.businessKey,
      contentHash: event.contentHash,
      dataType: event.dataType,
      operation: event.operation,
      approvedVersion: event.version,
      payload: event.payload,
    }));
  }
  const publicVersion = events.length ? events[events.length - 1].version : 0;
  const generatedAt = events.length ? events[events.length - 1].approvedAt : new Date(now).toISOString();
  return Object.freeze({
    schemaVersion: PUBLIC_SNAPSHOT_SCHEMA_VERSION,
    payloadSchemaVersion: 1,
    groupId,
    libraryId,
    publicVersion,
    snapshotVersion: publicVersion,
    cursor: `pv_${publicVersion}`,
    generatedAt,
    records: Object.freeze([...records.values()].sort((a, b) => a.businessKey.localeCompare(b.businessKey))),
    tombstones: Object.freeze([]),
  });
}

async function ensureLatestSnapshot(store, groupId, libraryId, now) {
  const snapshot = await buildPublicSnapshot({ store, groupId, libraryId, now });
  if (snapshot.publicVersion === 0) return Object.freeze({ snapshot, snapshotKey: null });
  const key = publicSnapshotKey(libraryId, snapshot.publicVersion);
  try {
    await putJSONOnlyIfNew(store, key, snapshot);
  } catch (error) {
    if (!ignoreAlreadyExists(error)) throw error;
    const existing = await getJSONStrong(store, key);
    if (!existing || canonicalize(existing) !== canonicalize(snapshot)) {
      throw new AutoApprovalError('SNAPSHOT_VERSION_CONFLICT', '同一公共版本对应了不同快照', 500, { key }, error);
    }
  }
  return Object.freeze({ snapshot, snapshotKey: key });
}

async function reserveEventSlot(store, submission, approvalId, approvalMode, markers, now) {
  const prefix = publicEventPrefix(submission.libraryId);
  for (let attempt = 0; attempt < MAX_EVENT_RESERVATION_ATTEMPTS; attempt += 1) {
    const keys = await listKeysStrong(store, prefix);
    let maxVersion = 0;
    for (const key of keys) {
      const version = eventVersionFromKey(prefix, key);
      if (version === null) {
        throw new AutoApprovalError('INVALID_PUBLIC_EVENT_KEY', '公共事件目录包含不符合协议的Key', 500, { key });
      }
      maxVersion = Math.max(maxVersion, version);
    }
    const version = maxVersion + 1;
    const eventKey = publicEventKey(submission.libraryId, version);
    const deviceIds = [...markers.keys()].sort();
    const submissionIds = deviceIds.map(deviceId => String(markers.get(deviceId)?.submissionId || '')).filter(Boolean);
    const event = Object.freeze({
      schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
      version,
      eventKey,
      approvalId,
      groupId: submission.groupId,
      libraryId: submission.libraryId,
      approvedAt: new Date(now).toISOString(),
      businessKey: submission.businessKey,
      contentHash: submission.contentHash,
      dataType: submission.dataType,
      operation: submission.operation,
      payload: submission.payload,
      approval: Object.freeze({
        mode: approvalMode,
        deviceIds: Object.freeze(deviceIds),
        submissionIds: Object.freeze(submissionIds),
      }),
    });
    try {
      await putJSONOnlyIfNew(store, eventKey, event);
      return event;
    } catch (error) {
      if (!ignoreAlreadyExists(error)) throw error;
    }
  }
  throw new AutoApprovalError('PUBLIC_EVENT_RESERVATION_EXHAUSTED', '公共事件版本预留重试次数已耗尽', 503);
}

async function publishAutomaticApproval({ store, submission, approvalMode, markers, now }) {
  const approvalId = approvalIdFor(submission);
  const indexKey = approvalIndexKey(submission.libraryId, approvalId);
  const existingIndex = await getJSONStrong(store, indexKey);
  if (existingIndex) {
    const index = assertApprovalIndex(existingIndex, approvalId);
    const event = assertPublicEvent(await getJSONStrong(store, index.eventKey), index.eventKey, index.version);
    const latest = await ensureLatestSnapshot(store, submission.groupId, submission.libraryId, now);
    return Object.freeze({ approvalId, index, event, ...latest, duplicateApproval: true });
  }

  const reservedEvent = await reserveEventSlot(store, submission, approvalId, approvalMode, markers, now);
  const proposedIndex = Object.freeze({
    schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
    approvalId,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    businessKey: submission.businessKey,
    contentHash: submission.contentHash,
    version: reservedEvent.version,
    eventKey: reservedEvent.eventKey,
    createdAt: now,
  });

  let index = proposedIndex;
  try {
    await putJSONOnlyIfNew(store, indexKey, proposedIndex);
  } catch (error) {
    if (!ignoreAlreadyExists(error)) throw error;
    index = assertApprovalIndex(await getJSONStrong(store, indexKey), approvalId);
  }

  const event = assertPublicEvent(await getJSONStrong(store, index.eventKey), index.eventKey, index.version);
  const latest = await ensureLatestSnapshot(store, submission.groupId, submission.libraryId, now);
  return Object.freeze({
    approvalId,
    index,
    event,
    ...latest,
    duplicateApproval: index.version !== proposedIndex.version,
  });
}

async function ensureReviewMarkers({ store, submission, confirmations, reason, existingRecord, now }) {
  const hashes = [...confirmations.keys()].sort();
  if (!hashes.includes(submission.contentHash)) hashes.push(submission.contentHash);
  for (const contentHash of hashes) {
    const markers = confirmations.get(contentHash) || new Map();
    const key = reviewMarkerKey(submission.libraryId, submission.businessKey, contentHash);
    const marker = Object.freeze({
      schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
      status: 'pending_review',
      reason,
      groupId: submission.groupId,
      libraryId: submission.libraryId,
      businessKey: submission.businessKey,
      contentHash,
      deviceIds: Object.freeze([...markers.keys()].sort()),
      publicContentHash: existingRecord?.contentHash || null,
      createdAt: now,
    });
    try {
      await putJSONOnlyIfNew(store, key, marker);
    } catch (error) {
      if (!ignoreAlreadyExists(error)) throw error;
    }
  }
}

function findSnapshotRecord(snapshot, businessKey) {
  return snapshot.records.find(record => record.businessKey === businessKey) || null;
}

export async function reviewExactPriceCandidate({
  store,
  candidate,
  now = Date.now(),
  trustedDeviceResolver = readTrustedDevice,
} = {}) {
  assertSafeTime(now);
  const submission = assertStoredCandidate(candidate);
  await ensureConfirmationMarker(store, candidate, submission);

  const confirmations = await collectBusinessConfirmations(store, submission);
  const matchingMarkers = confirmations.get(submission.contentHash) || new Map();
  const trustedDevice = Boolean(await trustedDeviceResolver(store, submission.deviceId));
  const currentSnapshot = await buildPublicSnapshot({
    store,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    now,
  });
  const existingRecord = findSnapshotRecord(currentSnapshot, submission.businessKey);
  const conflictingCandidateCount = [...confirmations.keys()].filter(hash => hash !== submission.contentHash).length;
  const eligibility = evaluateExactPriceCandidate({
    submission,
    existingRecord: existingRecord
      ? { businessKey: existingRecord.businessKey, contentHash: existingRecord.contentHash }
      : null,
    matchingDistinctDeviceCount: Math.max(1, matchingMarkers.size),
    trustedDevice,
    conflictingCandidateCount,
  });

  if (eligibility.decision === 'duplicate_noop') {
    return Object.freeze({
      schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
      status: 'auto_approved',
      decision: eligibility.decision,
      reason: eligibility.reason,
      approvalMode: 'public_duplicate',
      matchingDistinctDeviceCount: matchingMarkers.size,
      publicVersion: currentSnapshot.publicVersion,
      eventVersion: existingRecord?.approvedVersion || null,
      publicMutationApplied: false,
      autoApprovalEnabled: true,
    });
  }

  if (eligibility.decision === 'pending_review') {
    await ensureReviewMarkers({
      store,
      submission,
      confirmations,
      reason: eligibility.reason,
      existingRecord,
      now,
    });
    return Object.freeze({
      schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
      status: 'pending_review',
      decision: eligibility.decision,
      reason: eligibility.reason,
      approvalMode: null,
      matchingDistinctDeviceCount: matchingMarkers.size,
      conflictingCandidateCount,
      publicVersion: currentSnapshot.publicVersion,
      eventVersion: null,
      publicMutationApplied: false,
      autoApprovalEnabled: true,
    });
  }

  if (eligibility.decision === 'waiting_confirmation') {
    return Object.freeze({
      schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
      status: 'waiting_confirmation',
      decision: eligibility.decision,
      reason: eligibility.reason,
      approvalMode: null,
      matchingDistinctDeviceCount: matchingMarkers.size,
      conflictingCandidateCount,
      publicVersion: currentSnapshot.publicVersion,
      eventVersion: null,
      publicMutationApplied: false,
      autoApprovalEnabled: true,
    });
  }

  if (eligibility.decision !== 'eligible_auto_approval') {
    throw new AutoApprovalError('UNSUPPORTED_REVIEW_DECISION', '自动审核返回了未知决策', 500, {
      decision: eligibility.decision,
    });
  }

  const approvalMode = trustedDevice ? 'trusted_device' : 'two_devices_match';
  const published = await publishAutomaticApproval({
    store,
    submission,
    approvalMode,
    markers: matchingMarkers,
    now,
  });
  return Object.freeze({
    schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
    status: 'auto_approved',
    decision: eligibility.decision,
    reason: eligibility.reason,
    approvalMode,
    approvalId: published.approvalId,
    matchingDistinctDeviceCount: matchingMarkers.size,
    conflictingCandidateCount,
    publicVersion: published.snapshot.publicVersion,
    eventVersion: published.event.version,
    snapshotKey: published.snapshotKey,
    publicMutationApplied: published.duplicateApproval !== true,
    duplicateApproval: published.duplicateApproval,
    autoApprovalEnabled: true,
  });
}
