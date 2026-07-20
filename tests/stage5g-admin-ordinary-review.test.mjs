import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
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
import {
  ADMIN_ORDINARY_REVIEW_CAPABILITIES,
  AdminOrdinaryReviewError,
  getAdminOrdinaryReviewDetail,
  getAdminOrdinaryReviewMutationTarget,
  isAdminOrdinaryReviewProjectionSafe,
  listAdminOrdinaryReviewQueue,
  readAdminOrdinaryReviewConfig,
} from '../src/server/admin_ordinary_review_projection_v1.js';
import {
  handleAdminOrdinaryReviewDetailRequest,
  handleAdminOrdinaryReviewQueueRequest,
} from '../src/server/admin_ordinary_review_http_v1.js';
import { pendingSubmissionKey } from '../src/server/blob_repository_v1.js';
import { reviewOrdinaryCandidate } from '../src/server/ordinary_public_engine_v1.js';
import {
  computeOrdinarySubmissionHashes,
  deriveBossId,
} from '../src/server/ordinary_types_policy_v1.js';
import { canonicalize } from '../src/server/submission_policy_v1.js';

const NOW = 1_784_530_000_000;
const GROUP = ADMIN_REVIEW_ALLOWED_GROUP_ID;
const LIBRARY = ADMIN_REVIEW_ALLOWED_LIBRARY_ID;
const USERNAME = 'stage5g-admin@example.test';
const PASSWORD = 'stage5g-admin-password-0123456789';
const SESSION_SECRET = 'stage5g-session-secret-012345678901234';
const RATE_SALT = 'stage5g-rate-limit-salt-0123456789012';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const DEVICE_C = 'dev_01JABCDEF0123456789XYZABCF';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_B = 'sub_01JABCDEF0123456789XYZABCE';
const SUB_C = 'sub_01JABCDEF0123456789XYZABCF';

const ENV = Object.freeze({
  CLOUD_ADMIN_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://cloud-collab-stage5g-test.edgeone.cool',
  CLOUD_ADMIN_USERNAME: USERNAME,
  CLOUD_ADMIN_PASSWORD: PASSWORD,
  CLOUD_ADMIN_SESSION_SECRET: SESSION_SECRET,
  CLOUD_ADMIN_RATE_LIMIT_SALT: RATE_SALT,
  CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME: ADMIN_REVIEW_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID: GROUP,
  CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID: LIBRARY,
  CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED: '1',
  CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ORDINARY_TYPES_ALLOWED_GROUP_ID: GROUP,
  CLOUD_ORDINARY_TYPES_ALLOWED_LIBRARY_ID: LIBRARY,
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
});

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.reads = [];
    this.lists = [];
  }

  clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
  }

  async get(key, options = {}) {
    this.reads.push({ key, options: this.clone(options) });
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

  async list(options = {}) {
    this.lists.push(this.clone(options));
    const prefix = String(options.prefix || '');
    return {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
}

function sha(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function complete(dataType, payload, {
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
    clientContext: {
      appVersion: '8.2.28-stage5g',
      projectionSpecVersion: 1,
      queueSchemaVersion: 1,
    },
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

async function storeAndReview(store, submission, now, trustedDeviceResolver) {
  const stored = candidate(submission, now);
  await store.setJSON(pendingSubmissionKey(submission.libraryId, submission.idempotencyKey), stored);
  return reviewOrdinaryCandidate({ store, candidate: stored, now, trustedDeviceResolver });
}

const alwaysTrusted = async () => true;
const neverTrusted = async () => false;

async function seedBossSensitiveChange() {
  const store = new MemoryBlobStore();
  const initial = complete('boss_profile', {
    bossName: '老板甲', paiDan: '直属A', discount: 0.97,
  });
  await storeAndReview(store, initial, NOW, alwaysTrusted);
  const changed = complete('boss_profile', {
    bossName: '老板甲', paiDan: '直属B', discount: 0.97,
  }, {
    deviceId: DEVICE_B,
    submissionId: SUB_B,
    bossId: deriveBossId(GROUP, '老板甲'),
  });
  const reviewed = await storeAndReview(store, changed, NOW + 1000, alwaysTrusted);
  assert.equal(reviewed.reason, 'boss_direct_report_change_sensitive');
  return { store, initial, changed };
}

async function seedPlayableCaseConflict() {
  const store = new MemoryBlobStore();
  const initial = complete('playable_name', { name: 'Alice' });
  await storeAndReview(store, initial, NOW, alwaysTrusted);
  const changed = complete('playable_name', { name: 'ALICE' }, {
    deviceId: DEVICE_C,
    submissionId: SUB_C,
  });
  assert.equal(changed.businessKey, initial.businessKey);
  assert.notEqual(changed.contentHash, initial.contentHash);
  const reviewed = await storeAndReview(store, changed, NOW + 2000, neverTrusted);
  assert.equal(reviewed.reason, 'playable_name_public_conflict');
  return { store };
}

function sessionCookie() {
  const config = readAdminAuthConfig(ENV);
  const session = createAdminSessionToken({
    config,
    now: NOW,
    randomBytes: size => Buffer.alloc(size, 17),
  });
  return `${ADMIN_SESSION_COOKIE_NAME}=${session.token}`;
}

function request(path, { method = 'GET', cookie = sessionCookie(), headers = {} } = {}) {
  return new Request(`${ENV.CLOUD_ADMIN_PUBLIC_ORIGIN}${path}`, {
    method,
    headers: {
      Origin: ENV.CLOUD_ADMIN_PUBLIC_ORIGIN,
      'Sec-Fetch-Site': 'same-origin',
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
  });
}

function expectCode(code, fn) {
  return assert.rejects(fn, error => error instanceof AdminOrdinaryReviewError && error.code === code);
}

test('Stage5G administrator ordinary review config requires both admin review and ordinary fixture gates', () => {
  assert.throws(
    () => readAdminOrdinaryReviewConfig({ ...ENV, CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED: '0' }),
    error => error.code === 'ORDINARY_TYPES_PREVIEW_DISABLED',
  );
  assert.throws(
    () => readAdminOrdinaryReviewConfig({ ...ENV, CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME: 'other-store' }),
    error => error.code === 'ORDINARY_TYPES_SCOPE_INVALID',
  );
  const config = readAdminOrdinaryReviewConfig(ENV);
  assert.equal(config.storeName, 'cloud-collab-preview-v1');
  assert.equal(config.ordinaryTypesEnabled, true);
});

test('Stage5G boss sensitive change is projected with its public baseline and no raw identifiers', async () => {
  const { store, initial, changed } = await seedBossSensitiveChange();
  const config = readAdminOrdinaryReviewConfig(ENV);
  const queue = await listAdminOrdinaryReviewQueue({ store, config });
  assert.equal(queue.total, 1);
  const item = queue.items[0];
  assert.equal(item.dataType, 'boss_profile');
  assert.equal(item.reason, 'boss_direct_report_change_sensitive');
  assert.deepEqual(item.payload, changed.payload);
  assert.equal(item.baseline.approvedVersion, 1);
  assert.deepEqual(item.baseline.payload, initial.payload);
  assert.equal(item.baseline.unitPrice, null);
  assert.equal(item.baseline.stillCurrent, true);
  assert.equal(isAdminOrdinaryReviewProjectionSafe(queue), true);
  const text = JSON.stringify(queue);
  for (const forbidden of [DEVICE_A, DEVICE_B, SUB_A, SUB_B, 'ik_v1_', 'req_v1_', 'reviews/', 'submissions/', 'public/']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.ok(store.lists.every(options => options.consistency === 'strong'));
  assert.ok(store.reads.every(entry => entry.options.consistency === 'strong'));
});

test('Stage5G playable-name conflict supports opaque detail and mutation-target reads', async () => {
  const { store } = await seedPlayableCaseConflict();
  const config = readAdminOrdinaryReviewConfig(ENV);
  const queue = await listAdminOrdinaryReviewQueue({ store, config });
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].dataType, 'playable_name');
  assert.equal(queue.items[0].payload.name, 'ALICE');
  assert.equal(queue.items[0].baseline.payload.name, 'Alice');
  const detail = await getAdminOrdinaryReviewDetail({ store, config, reviewId: queue.items[0].reviewId });
  assert.equal(detail.variantCount, 1);
  assert.equal(isAdminOrdinaryReviewProjectionSafe(detail), true);
  const target = await getAdminOrdinaryReviewMutationTarget({ store, config, reviewId: queue.items[0].reviewId });
  assert.equal(target.submission.dataType, 'playable_name');
  assert.equal(target.baseline.unitPrice, null);
  assert.equal(target.evidence.length, 1);
  await expectCode('ADMIN_ORDINARY_REVIEW_ID_INVALID', () => getAdminOrdinaryReviewDetail({
    store,
    config,
    reviewId: '../../public/events',
  }));
});

test('Stage5G ordinary review HTTP is authenticated, query-strict, GET-only, and projection-safe', async () => {
  const { store } = await seedBossSensitiveChange();
  let stores = 0;
  const dependencies = {
    now: () => NOW,
    createStore: env => {
      stores += 1;
      assert.equal(env.CLOUD_BLOB_STORE_NAME, 'cloud-collab-preview-v1');
      return store;
    },
  };
  const denied = await handleAdminOrdinaryReviewQueueRequest({
    env: ENV,
    request: request('/api/admin/ordinary-reviews', { cookie: null }),
  }, dependencies);
  assert.equal(denied.status, 401);
  assert.equal(stores, 0);
  const invalidQuery = await handleAdminOrdinaryReviewQueueRequest({
    env: ENV,
    request: request('/api/admin/ordinary-reviews?unexpected=1'),
  }, dependencies);
  assert.equal(invalidQuery.status, 400);
  assert.equal(stores, 0);
  const response = await handleAdminOrdinaryReviewQueueRequest({
    env: ENV,
    request: request('/api/admin/ordinary-reviews'),
  }, dependencies);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.total, 1);
  assert.deepEqual(payload.data.capabilities, ADMIN_ORDINARY_REVIEW_CAPABILITIES);
  assert.equal(payload.data.capabilities.reviewMutation, false);
  const detail = await handleAdminOrdinaryReviewDetailRequest({
    env: ENV,
    request: request(`/api/admin/ordinary-reviews/detail?id=${payload.data.items[0].reviewId}`),
  }, dependencies);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.review.dataType, 'boss_profile');
  const post = await handleAdminOrdinaryReviewDetailRequest({
    env: ENV,
    request: request('/api/admin/ordinary-reviews/detail', { method: 'POST' }),
  }, dependencies);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
});
