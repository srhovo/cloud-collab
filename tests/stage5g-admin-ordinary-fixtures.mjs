import { createHash } from 'node:crypto';
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_PREVIEW_STORE_NAME,
  createAdminSessionToken,
  readAdminAuthConfig,
} from '../src/server/admin_auth_v1.js';
import {
  ADMIN_REVIEW_ALLOWED_GROUP_ID,
  ADMIN_REVIEW_ALLOWED_LIBRARY_ID,
  ADMIN_REVIEW_PREVIEW_STORE_NAME,
} from '../src/server/admin_review_projection_v1.js';
import { listAdminOrdinaryReviewQueue } from '../src/server/admin_ordinary_review_projection_v1.js';
import { readAdminOrdinaryReviewMutationConfig } from '../src/server/admin_ordinary_review_mutation_v1.js';
import { pendingSubmissionKey } from '../src/server/blob_repository_v1.js';
import { reviewOrdinaryCandidate } from '../src/server/ordinary_public_engine_v1.js';
import { computeOrdinarySubmissionHashes, deriveBossId } from '../src/server/ordinary_types_policy_v1.js';
import { canonicalize } from '../src/server/submission_policy_v1.js';

export const NOW = 1_784_540_000_000;
export const GROUP = ADMIN_REVIEW_ALLOWED_GROUP_ID;
export const LIBRARY = ADMIN_REVIEW_ALLOWED_LIBRARY_ID;
export const USERNAME = 'stage5g-mutation-admin@example.test';
export const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
export const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
export const DEVICE_C = 'dev_01JABCDEF0123456789XYZABCF';
export const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
export const SUB_B = 'sub_01JABCDEF0123456789XYZABCE';
export const SUB_C = 'sub_01JABCDEF0123456789XYZABCF';

export const ENV = Object.freeze({
  CLOUD_ADMIN_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://cloud-collab-stage5g-mutation.edgeone.cool',
  CLOUD_ADMIN_USERNAME: USERNAME,
  CLOUD_ADMIN_PASSWORD: 'stage5g-mutation-password-0123456789',
  CLOUD_ADMIN_SESSION_SECRET: 'stage5g-mutation-session-012345678901234',
  CLOUD_ADMIN_RATE_LIMIT_SALT: 'stage5g-mutation-rate-salt-0123456789012',
  CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME: ADMIN_REVIEW_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID: GROUP,
  CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID: LIBRARY,
  CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '1',
  CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED: '1',
  CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ORDINARY_TYPES_ALLOWED_GROUP_ID: GROUP,
  CLOUD_ORDINARY_TYPES_ALLOWED_LIBRARY_ID: LIBRARY,
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
});

export const IDENTITY = Object.freeze({
  username: USERNAME,
  sessionIdSuffix: '5G01',
  expiresAt: NOW + 900_000,
});

export class MemoryBlobStore {
  constructor() {
    this.values = new Map();
  }
  clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
  }
  async get(key) {
    return this.values.has(key) ? this.clone(this.values.get(key)) : null;
  }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.values.set(key, this.clone(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
  async list({ prefix = '' } = {}) {
    return {
      blobs: [...this.values.keys()].filter(key => key.startsWith(prefix)).sort().map(key => ({ key })),
    };
  }
}

function sha(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

export function complete(dataType, payload, {
  deviceId = DEVICE_A,
  submissionId = SUB_A,
  bossId = null,
} = {}) {
  const raw = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId: GROUP,
    libraryId: LIBRARY,
    bossId,
    dataType,
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: NOW - 1000,
    businessKey: `bk_v1_${'A'.repeat(43)}`,
    contentHash: `ch_v1_${'A'.repeat(43)}`,
    idempotencyKey: `ik_v1_${'A'.repeat(43)}`,
    payload,
    clientContext: { appVersion: '8.2.28-stage5g', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  const computed = computeOrdinarySubmissionHashes(raw);
  return {
    ...raw,
    bossId: computed.submission.bossId,
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    idempotencyKey: computed.idempotencyKey,
  };
}

function candidate(submission, receivedAt) {
  return {
    schemaVersion: 1,
    requestHash: `req_v1_${sha(canonicalize(submission))}`,
    status: 'waiting_confirmation',
    decision: 'waiting_confirmation',
    reason: 'second_device_required',
    submission,
    receivedAt,
    authenticatedTokenVersion: 1,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
  };
}

export async function storeAndReview(store, submission, now, trustedDeviceResolver = async () => false) {
  const stored = candidate(submission, now);
  await store.setJSON(pendingSubmissionKey(submission.libraryId, submission.idempotencyKey), stored);
  return reviewOrdinaryCandidate({ store, candidate: stored, now, trustedDeviceResolver });
}

export async function seedNewBossConflict() {
  const store = new MemoryBlobStore();
  const first = complete('boss_profile', { bossName: '老板甲', paiDan: '直属A', discount: 0.97 });
  const second = complete('boss_profile', { bossName: '老板甲', paiDan: '直属A', discount: 0.96 }, {
    deviceId: DEVICE_B,
    submissionId: SUB_B,
  });
  await storeAndReview(store, first, NOW);
  const reviewed = await storeAndReview(store, second, NOW + 1000);
  if (reviewed.reason !== 'candidate_conflict') throw new Error('fixture candidate conflict not created');
  const config = readAdminOrdinaryReviewMutationConfig(ENV);
  const queue = await listAdminOrdinaryReviewQueue({ store, config });
  return { store, config, queue, first, second };
}

export async function seedPlayablePublicConflict() {
  const store = new MemoryBlobStore();
  const initial = complete('playable_name', { name: 'Alice' });
  await storeAndReview(store, initial, NOW, async () => true);
  const changed = complete('playable_name', { name: 'ALICE' }, {
    deviceId: DEVICE_C,
    submissionId: SUB_C,
  });
  const reviewed = await storeAndReview(store, changed, NOW + 1000);
  if (reviewed.reason !== 'playable_name_public_conflict') throw new Error('fixture playable conflict not created');
  const config = readAdminOrdinaryReviewMutationConfig(ENV);
  const queue = await listAdminOrdinaryReviewQueue({ store, config });
  return { store, config, queue, initial, changed };
}

export async function seedSensitiveBossChange() {
  const store = new MemoryBlobStore();
  const initial = complete('boss_profile', { bossName: '老板乙', paiDan: '直属A', discount: 0.97 });
  await storeAndReview(store, initial, NOW, async () => true);
  const changed = complete('boss_profile', { bossName: '老板乙', paiDan: '直属B', discount: 0.97 }, {
    deviceId: DEVICE_B,
    submissionId: SUB_B,
    bossId: deriveBossId(GROUP, '老板乙'),
  });
  const reviewed = await storeAndReview(store, changed, NOW + 1000, async () => true);
  if (reviewed.reason !== 'boss_direct_report_change_sensitive') throw new Error('fixture sensitive change not created');
  const config = readAdminOrdinaryReviewMutationConfig(ENV);
  const queue = await listAdminOrdinaryReviewQueue({ store, config });
  return { store, config, queue };
}

export function keys(store, prefix) {
  return [...store.values.keys()].filter(key => key.startsWith(prefix)).sort();
}

export function sessionCookie() {
  const config = readAdminAuthConfig(ENV);
  const session = createAdminSessionToken({ config, now: NOW, randomBytes: size => Buffer.alloc(size, 19) });
  return `${ADMIN_SESSION_COOKIE_NAME}=${session.token}`;
}

export function request(path, {
  method = 'POST',
  body = null,
  cookie = sessionCookie(),
  origin = ENV.CLOUD_ADMIN_PUBLIC_ORIGIN,
  contentType = 'application/json',
} = {}) {
  return new Request(`${ENV.CLOUD_ADMIN_PUBLIC_ORIGIN}${path}`, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      'Sec-Fetch-Site': 'same-origin',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    ...(body === null ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
