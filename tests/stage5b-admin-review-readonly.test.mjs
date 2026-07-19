import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  ADMIN_REVIEW_CAPABILITIES,
  ADMIN_REVIEW_MAX_OBJECTS,
  ADMIN_REVIEW_PREVIEW_STORE_NAME,
  AdminReviewError,
  getAdminReviewDetail,
  isAdminReviewProjectionSafe,
  listAdminReviewQueue,
  readAdminReviewConfig,
} from '../src/server/admin_review_projection_v1.js';
import {
  handleAdminReviewDetailRequest,
  handleAdminReviewQueueRequest,
} from '../src/server/admin_review_http_v1.js';
import { reviewExactPriceCandidate } from '../src/server/auto_approval_engine_v1.js';
import { pendingSubmissionKey } from '../src/server/blob_repository_v1.js';
import {
  buildIdempotencyKey,
  computeSubmissionHashes,
} from '../src/server/submission_policy_v1.js';

const NOW = 1_784_420_000_000;
const USERNAME = 'stage5b-admin@example.test';
const PASSWORD = 'stage5b-admin-password-0123456789';
const SESSION_SECRET = 'stage5b-session-secret-012345678901234';
const RATE_SALT = 'stage5b-rate-limit-salt-0123456789012';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_B = 'sub_01JABCDEF0123456789XYZABCE';

const ENV = Object.freeze({
  CLOUD_ADMIN_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://cloud-collab-stage5b-test-dpxqrhy0935t.edgeone.cool',
  CLOUD_ADMIN_USERNAME: USERNAME,
  CLOUD_ADMIN_PASSWORD: PASSWORD,
  CLOUD_ADMIN_SESSION_SECRET: SESSION_SECRET,
  CLOUD_ADMIN_RATE_LIMIT_SALT: RATE_SALT,
  CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME: ADMIN_REVIEW_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID: ADMIN_REVIEW_ALLOWED_GROUP_ID,
  CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID: ADMIN_REVIEW_ALLOWED_LIBRARY_ID,
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

function submission({
  deviceId,
  submissionId,
  unitPrice,
  serviceName = '阶段5B合成服务',
} = {}) {
  const value = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId: ADMIN_REVIEW_ALLOWED_GROUP_ID,
    libraryId: ADMIN_REVIEW_ALLOWED_LIBRARY_ID,
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: NOW,
    businessKey: 'bk_v1_0000000000000000000000000000000000000000000',
    contentHash: 'ch_v1_0000000000000000000000000000000000000000000',
    idempotencyKey: buildIdempotencyKey(deviceId, submissionId),
    payload: { serviceName, settleType: 'round', unitPrice },
    clientContext: { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  const computed = computeSubmissionHashes(value);
  value.businessKey = computed.businessKey;
  value.contentHash = computed.contentHash;
  value.idempotencyKey = computed.idempotencyKey;
  return value;
}

function candidate(raw, receivedAt) {
  return {
    schemaVersion: 1,
    requestHash: 'req_v1_0000000000000000000000000000000000000000000',
    status: 'waiting_confirmation',
    decision: 'waiting_confirmation',
    reason: 'second_device_required',
    submission: raw,
    receivedAt,
    authenticatedTokenVersion: 1,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
  };
}

async function seedConflict() {
  const store = new MemoryBlobStore();
  const first = submission({ deviceId: DEVICE_A, submissionId: SUB_A, unitPrice: 100 });
  const second = submission({ deviceId: DEVICE_B, submissionId: SUB_B, unitPrice: 105 });
  const firstCandidate = candidate(first, NOW + 10);
  const secondCandidate = candidate(second, NOW + 20);
  await store.setJSON(pendingSubmissionKey(first.libraryId, first.idempotencyKey), firstCandidate);
  await store.setJSON(pendingSubmissionKey(second.libraryId, second.idempotencyKey), secondCandidate);
  await reviewExactPriceCandidate({ store, candidate: firstCandidate, now: NOW + 30 });
  const result = await reviewExactPriceCandidate({ store, candidate: secondCandidate, now: NOW + 40 });
  assert.equal(result.status, 'pending_review');
  return { store, first, second };
}

function deterministicRandomBytes(size) {
  return Buffer.alloc(size, 11);
}

function sessionCookie() {
  const authConfig = readAdminAuthConfig(ENV);
  const session = createAdminSessionToken({ config: authConfig, now: NOW, randomBytes: deterministicRandomBytes });
  return `${ADMIN_SESSION_COOKIE_NAME}=${session.token}`;
}

function request(path, { method = 'GET', cookie = sessionCookie(), headers = {} } = {}) {
  return new Request(`http://edgeone-cloud-function.internal${path}`, {
    method,
    headers: {
      'Sec-Fetch-Site': 'same-origin',
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
  });
}

function expectReviewCode(code, fn) {
  return assert.rejects(fn, error => error instanceof AdminReviewError && error.code === code);
}

test('Stage5B config is default-off and hard-locked to the synthetic review scope', () => {
  assert.throws(() => readAdminReviewConfig({}), error => error.code === 'ADMIN_REVIEW_PREVIEW_DISABLED');
  assert.throws(
    () => readAdminReviewConfig({ ...ENV, CLOUD_ADMIN_PREVIEW_ENABLED: '0' }),
    error => error.code === 'ADMIN_REVIEW_REQUIRES_ADMIN_AUTH',
  );
  assert.throws(
    () => readAdminReviewConfig({ ...ENV, CLOUD_WRITE_PREVIEW_ENABLED: '1' }),
    error => error.code === 'ADMIN_REVIEW_REQUIRES_PUBLIC_PREVIEW_DISABLED',
  );
  for (const [name, value] of [
    ['CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME', 'formal-user-prices'],
    ['CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID', 'group_xiacijian'],
    ['CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID', 'lib_xiacijian_regular'],
  ]) {
    assert.throws(
      () => readAdminReviewConfig({ ...ENV, [name]: value }),
      error => error.code === 'ADMIN_REVIEW_SCOPE_MISCONFIGURED',
    );
  }
  const config = readAdminReviewConfig(ENV);
  assert.deepEqual(config, {
    storeName: ADMIN_REVIEW_PREVIEW_STORE_NAME,
    groupId: ADMIN_REVIEW_ALLOWED_GROUP_ID,
    libraryId: ADMIN_REVIEW_ALLOWED_LIBRARY_ID,
    maxObjects: ADMIN_REVIEW_MAX_OBJECTS,
  });
});

test('queue performs strong chained reads and returns only a safe synthetic projection', async () => {
  const { store } = await seedConflict();
  const queue = await listAdminReviewQueue({ store, config: readAdminReviewConfig(ENV) });
  assert.equal(queue.total, 2);
  assert.equal(queue.scope.syntheticFixtureOnly, true);
  assert.deepEqual(queue.items.map(item => item.candidateUnitPrice).sort((a, b) => a - b), [100, 105]);
  assert.ok(queue.items.every(item => item.status === 'pending_review'));
  assert.ok(queue.items.every(item => item.reason === 'candidate_conflict'));
  assert.ok(queue.items.every(item => item.baseline.approvedVersion === 0));
  assert.ok(queue.items.every(item => /^rv_v1_[A-Za-z0-9_-]{43}$/.test(item.reviewId)));
  assert.ok(queue.items.every(item => item.deviceTags.every(tag => /^设备-[A-Za-z0-9_-]{8}$/.test(tag))));
  assert.equal(isAdminReviewProjectionSafe(queue), true);
  const text = JSON.stringify(queue);
  for (const forbidden of [DEVICE_A, DEVICE_B, SUB_A, SUB_B, 'ik_v1_', 'req_v1_', 'reviews/', 'submissions/']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.ok(store.lists.every(options => options.consistency === 'strong'));
  assert.ok(store.reads.every(entry => entry.options.consistency === 'strong'));
});

test('detail uses an opaque ID and returns sibling conflict variants without storage paths', async () => {
  const { store } = await seedConflict();
  const config = readAdminReviewConfig(ENV);
  const queue = await listAdminReviewQueue({ store, config });
  const detail = await getAdminReviewDetail({ store, config, reviewId: queue.items[0].reviewId });
  assert.equal(detail.variantCount, 2);
  assert.equal(detail.conflictPresent, true);
  assert.deepEqual(detail.variants.map(item => item.candidateUnitPrice).sort((a, b) => a - b), [100, 105]);
  assert.equal(isAdminReviewProjectionSafe(detail), true);
  await expectReviewCode('ADMIN_REVIEW_ID_INVALID', () => getAdminReviewDetail({
    store,
    config,
    reviewId: '../../public/lib/events',
  }));
  await expectReviewCode('ADMIN_REVIEW_NOT_FOUND', () => getAdminReviewDetail({
    store,
    config,
    reviewId: `rv_v1_${'Z'.repeat(43)}`,
  }));
});

test('malformed marker keys, tampered candidates, or an oversized queue fail closed', async () => {
  const config = readAdminReviewConfig(ENV);
  const malformed = new MemoryBlobStore();
  await malformed.setJSON(`reviews/${config.libraryId}/pending/not-a-review.json`, { schemaVersion: 1 });
  await expectReviewCode('ADMIN_REVIEW_INVALID_OBJECT_KEY', () => listAdminReviewQueue({ store: malformed, config }));

  const seeded = await seedConflict();
  const pendingKey = pendingSubmissionKey(seeded.first.libraryId, seeded.first.idempotencyKey);
  const corrupted = seeded.store.values.get(pendingKey);
  corrupted.submission.payload.unitPrice = 999;
  seeded.store.values.set(pendingKey, corrupted);
  await expectReviewCode('ADMIN_REVIEW_INVALID_CANDIDATE', () => listAdminReviewQueue({
    store: seeded.store,
    config,
  }));

  const oversized = new MemoryBlobStore();
  for (let index = 0; index <= ADMIN_REVIEW_MAX_OBJECTS; index += 1) {
    await oversized.setJSON(`reviews/${config.libraryId}/pending/fake-${index}.json`, {});
  }
  await expectReviewCode('ADMIN_REVIEW_OBJECT_LIMIT_EXCEEDED', () => listAdminReviewQueue({
    store: oversized,
    config,
  }));
});

test('HTTP queue authenticates before Blob access and exposes read-only capabilities only', async () => {
  const { store } = await seedConflict();
  let stores = 0;
  const dependencies = {
    now: () => NOW,
    createStore: env => {
      stores += 1;
      assert.equal(env.CLOUD_BLOB_STORE_NAME, ADMIN_REVIEW_PREVIEW_STORE_NAME);
      return store;
    },
  };
  const denied = await handleAdminReviewQueueRequest({
    env: ENV,
    request: request('/api/admin/reviews', { cookie: null }),
  }, dependencies);
  assert.equal(denied.status, 401);
  assert.equal(stores, 0);
  assert.match(denied.headers.get('set-cookie'), /Max-Age=0/);

  const invalidQuery = await handleAdminReviewQueueRequest({
    env: ENV,
    request: request('/api/admin/reviews?unexpected=1'),
  }, dependencies);
  assert.equal(invalidQuery.status, 400);
  assert.equal(stores, 0);

  const response = await handleAdminReviewQueueRequest({
    env: ENV,
    request: request('/api/admin/reviews'),
  }, dependencies);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  const text = await response.text();
  const payload = JSON.parse(text);
  assert.equal(payload.data.total, 2);
  assert.deepEqual(payload.data.capabilities, ADMIN_REVIEW_CAPABILITIES);
  assert.equal(payload.data.capabilities.reviewQueueRead, true);
  assert.equal(payload.data.capabilities.reviewMutation, false);
  for (const forbidden of [DEVICE_A, DEVICE_B, SUB_A, SUB_B, 'ik_v1_', 'reviews/', 'submissions/']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('HTTP detail is authenticated, query-strict, GET-only, and remains mutation-free', async () => {
  const { store } = await seedConflict();
  const config = readAdminReviewConfig(ENV);
  const queue = await listAdminReviewQueue({ store, config });
  const dependencies = { now: () => NOW, createStore: () => store };
  const response = await handleAdminReviewDetailRequest({
    env: ENV,
    request: request(`/api/admin/reviews/detail?id=${queue.items[0].reviewId}`),
  }, dependencies);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.variantCount, 2);
  assert.equal(payload.data.capabilities.reviewMutation, false);

  const duplicate = await handleAdminReviewDetailRequest({
    env: ENV,
    request: request(`/api/admin/reviews/detail?id=${queue.items[0].reviewId}&id=${queue.items[1].reviewId}`),
  }, dependencies);
  assert.equal(duplicate.status, 400);

  const post = await handleAdminReviewDetailRequest({
    env: ENV,
    request: request('/api/admin/reviews/detail', { method: 'POST' }),
  }, dependencies);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
});

test('HTTP response guard blocks an injected raw identifier without reflecting it', async () => {
  const response = await handleAdminReviewQueueRequest({
    env: ENV,
    request: request('/api/admin/reviews'),
  }, {
    now: () => NOW,
    createStore: () => new MemoryBlobStore(),
    listQueue: async () => ({
      scope: { groupId: ADMIN_REVIEW_ALLOWED_GROUP_ID, libraryId: ADMIN_REVIEW_ALLOWED_LIBRARY_ID },
      total: 1,
      items: [{ deviceId: DEVICE_A }],
    }),
  });
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(text.includes(DEVICE_A), false);
  assert.match(text, /管理员只读审核暂时不可用/);
});

test('temporary Stage5B page is secret-free, storage-free, unlinked from user pages, and calls no mutation route', () => {
  const page = fs.readFileSync('dist/admin-reviews-preview.html', 'utf8');
  const adminAuthPage = fs.readFileSync('dist/admin-preview.html', 'utf8');
  const userSource = fs.readFileSync('src/码单器8.2.26_公共协作本地候选版.html', 'utf8');
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
  assert.match(page, /\/api\/admin\/reviews/);
  assert.match(page, /\/api\/admin\/reviews\/detail/);
  assert.match(page, /reviewMutation/);
  assert.doesNotMatch(page, /(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)/);
  assert.doesNotMatch(page, /indexedDB\.(?:open|deleteDatabase)/);
  assert.doesNotMatch(page, /console\.(?:log|warn|error)/);
  assert.doesNotMatch(page, /CLOUD_ADMIN_(?:PASSWORD|SESSION_SECRET|RATE_LIMIT_SALT)/);
  assert.doesNotMatch(page, /\/api\/admin\/(?:approve|reject|rollback|export|devices)/);
  assert.doesNotMatch(page, /\/api\/(?:submissions|preview)\//);
  assert.doesNotMatch(adminAuthPage, /admin-reviews-preview|\/api\/admin\/reviews/);
  assert.doesNotMatch(userSource, /admin-reviews-preview|\/api\/admin\/reviews/);
});

test('Stage5B env defaults are closed and route files import only read handlers', async () => {
  const env = fs.readFileSync('.env.example', 'utf8');
  assert.match(env, /^CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED=0$/m);
  assert.match(env, /^CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME=cloud-collab-preview-v1$/m);
  assert.match(env, /^CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID=group_fixture$/m);
  assert.match(env, /^CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID=lib_receive_fixture$/m);
  const queueRoute = fs.readFileSync('cloud-functions/api/admin/reviews.js', 'utf8');
  const detailRoute = fs.readFileSync('cloud-functions/api/admin/reviews/detail.js', 'utf8');
  assert.match(queueRoute, /handleAdminReviewQueueRequest/);
  assert.match(detailRoute, /handleAdminReviewDetailRequest/);
  for (const source of [queueRoute, detailRoute]) {
    assert.doesNotMatch(source, /(?:Approve|Reject|Mutation|Rollback|Export|Trust|Block)/);
  }
  const modules = await Promise.all([
    import('../cloud-functions/api/admin/reviews.js'),
    import('../cloud-functions/api/admin/reviews/detail.js'),
  ]);
  assert.ok(modules.every(module => typeof module.default === 'function'));
});
