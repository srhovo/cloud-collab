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
  ADMIN_REVIEW_PREVIEW_STORE_NAME,
  getAdminReviewMutationTarget,
  listAdminReviewQueue,
} from '../src/server/admin_review_projection_v1.js';
import {
  ADMIN_REVIEW_MUTATION_CAPABILITIES,
  AdminReviewMutationError,
  isAdminReviewMutationProjectionSafe,
  mutateAdminReview,
  normalizeAdminReviewCommand,
  readAdminReviewMutationConfig,
} from '../src/server/admin_review_mutation_v1.js';
import {
  handleAdminReviewApproveRequest,
  handleAdminReviewEditAndApproveRequest,
  handleAdminReviewRejectRequest,
} from '../src/server/admin_review_mutation_http_v1.js';
import {
  buildPublicSnapshot,
  listValidPublicEvents,
  publishAdminReviewApproval,
  reviewExactPriceCandidate,
} from '../src/server/auto_approval_engine_v1.js';
import { pendingSubmissionKey } from '../src/server/blob_repository_v1.js';
import {
  buildIdempotencyKey,
  computeSubmissionHashes,
} from '../src/server/submission_policy_v1.js';

const NOW = 1_784_423_600_000;
const USERNAME = 'stage5c-admin@example.test';
const PASSWORD = 'stage5c-admin-password-0123456789';
const SESSION_SECRET = 'stage5c-session-secret-012345678901234';
const RATE_SALT = 'stage5c-rate-limit-salt-0123456789012';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_B = 'sub_01JABCDEF0123456789XYZABCE';

const ENV = Object.freeze({
  CLOUD_ADMIN_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_USERNAME: USERNAME,
  CLOUD_ADMIN_PASSWORD: PASSWORD,
  CLOUD_ADMIN_SESSION_SECRET: SESSION_SECRET,
  CLOUD_ADMIN_RATE_LIMIT_SALT: RATE_SALT,
  CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME: ADMIN_REVIEW_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID: ADMIN_REVIEW_ALLOWED_GROUP_ID,
  CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID: ADMIN_REVIEW_ALLOWED_LIBRARY_ID,
  CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '1',
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
});

const IDENTITY = Object.freeze({
  username: USERNAME,
  sessionIdSuffix: '5C01',
  expiresAt: NOW + 900_000,
});

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.reads = [];
    this.lists = [];
    this.failPrefixOnce = null;
  }

  clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
  }

  async get(key, options = {}) {
    this.reads.push({ key, options: this.clone(options) });
    return this.values.has(key) ? this.clone(this.values.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    if (this.failPrefixOnce && key.startsWith(this.failPrefixOnce)) {
      this.failPrefixOnce = null;
      throw new Error('injected write interruption');
    }
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

function submission({ deviceId, submissionId, unitPrice, serviceName = '阶段5C合成服务' } = {}) {
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
  const reviewed = await reviewExactPriceCandidate({ store, candidate: secondCandidate, now: NOW + 40 });
  assert.equal(reviewed.status, 'pending_review');
  return { store, first, second };
}

function keysWithPrefix(store, prefix) {
  return [...store.values.keys()].filter(key => key.startsWith(prefix)).sort();
}

async function queueFor(store) {
  return listAdminReviewQueue({ store, config: readAdminReviewMutationConfig(ENV) });
}

function command(action, input) {
  return { action, input };
}

function deterministicRandomBytes(size) {
  return Buffer.alloc(size, 13);
}

function sessionCookie() {
  const authConfig = readAdminAuthConfig(ENV);
  const session = createAdminSessionToken({ config: authConfig, now: NOW, randomBytes: deterministicRandomBytes });
  return `${ADMIN_SESSION_COOKIE_NAME}=${session.token}`;
}

function request(path, {
  method = 'POST',
  body = null,
  cookie = sessionCookie(),
  origin = 'https://stage5c-admin.test',
  contentType = 'application/json',
  headers = {},
} = {}) {
  return new Request(`https://stage5c-admin.test${path}`, {
    method,
    headers: {
      'Sec-Fetch-Site': 'same-origin',
      ...(origin ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(contentType ? { 'Content-Type': contentType } : {}),
      ...headers,
    },
    ...(body === null ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

function expectMutationCode(code, fn) {
  return assert.rejects(fn, error => error?.code === code);
}

test('Stage5C config is default-off, inherits the Stage5B synthetic hard lock, and commands require explicit confirmation', () => {
  assert.throws(() => readAdminReviewMutationConfig({}), error => error.code === 'ADMIN_REVIEW_MUTATION_PREVIEW_DISABLED');
  assert.throws(
    () => readAdminReviewMutationConfig({ ...ENV, CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '0' }),
    error => error.code === 'ADMIN_REVIEW_PREVIEW_DISABLED',
  );
  assert.throws(
    () => readAdminReviewMutationConfig({ ...ENV, CLOUD_WRITE_PREVIEW_ENABLED: '1' }),
    error => error.code === 'ADMIN_REVIEW_REQUIRES_PUBLIC_PREVIEW_DISABLED',
  );
  assert.equal(readAdminReviewMutationConfig(ENV).mutationPreviewEnabled, true);
  assert.throws(
    () => normalizeAdminReviewCommand('approve', { reviewId: `rv_v1_${'A'.repeat(43)}`, confirmation: 'YES' }),
    error => error.code === 'ADMIN_REVIEW_CONFIRMATION_REQUIRED',
  );
  assert.throws(
    () => normalizeAdminReviewCommand('reject', {
      reviewId: `rv_v1_${'A'.repeat(43)}`,
      confirmation: 'REJECT',
      reasonCode: 'free_text_reason',
    }),
    error => error.code === 'ADMIN_REVIEW_REJECTION_INVALID',
  );
});

test('approve publishes exactly one admin event, archives every sibling, and replays idempotently', async () => {
  const { store } = await seedConflict();
  const config = readAdminReviewMutationConfig(ENV);
  const before = await queueFor(store);
  const selected = before.items.find(item => item.candidateUnitPrice === 100);
  const input = { reviewId: selected.reviewId, confirmation: 'APPROVE' };
  const result = await mutateAdminReview({
    store,
    config,
    identity: IDENTITY,
    command: command('approve', input),
    now: NOW + 100,
  });
  assert.equal(result.status, 'approved_by_admin');
  assert.equal(result.publicVersion, 1);
  assert.equal(result.eventVersion, 1);
  assert.equal(result.publicMutationApplied, true);
  assert.equal(result.resolvedReviewCount, 2);
  assert.equal(result.duplicate, false);
  assert.equal(isAdminReviewMutationProjectionSafe(result), true);

  const events = await listValidPublicEvents({ store, libraryId: config.libraryId });
  assert.equal(events.length, 1);
  assert.equal(events[0].approval.mode, 'admin_approved');
  assert.equal(events[0].payload.unitPrice, 100);
  assert.equal((await queueFor(store)).total, 0);
  assert.equal(keysWithPrefix(store, 'audit/').length, 1);
  assert.equal(keysWithPrefix(store, `reviews/${config.libraryId}/resolved/`).length, 2);

  const replay = await mutateAdminReview({
    store,
    config,
    identity: IDENTITY,
    command: command('approve', input),
    now: NOW + 9999,
  });
  assert.equal(replay.duplicate, true);
  assert.equal((await listValidPublicEvents({ store, libraryId: config.libraryId })).length, 1);
  await expectMutationCode('ADMIN_REVIEW_ALREADY_DECIDED', () => mutateAdminReview({
    store,
    config,
    identity: IDENTITY,
    command: command('reject', {
      reviewId: selected.reviewId,
      confirmation: 'REJECT',
      reasonCode: 'conflicting_candidates',
    }),
    now: NOW + 10_000,
  }));
});

test('reject writes immutable audit and one resolution without changing the public version', async () => {
  const { store } = await seedConflict();
  const config = readAdminReviewMutationConfig(ENV);
  const before = await queueFor(store);
  const selected = before.items.find(item => item.candidateUnitPrice === 100);
  const input = {
    reviewId: selected.reviewId,
    confirmation: 'REJECT',
    reasonCode: 'conflicting_candidates',
  };
  const result = await mutateAdminReview({
    store,
    config,
    identity: IDENTITY,
    command: command('reject', input),
    now: NOW + 200,
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.publicVersion, 0);
  assert.equal(result.eventVersion, null);
  assert.equal(result.publicMutationApplied, false);
  assert.equal(result.resolvedReviewCount, 1);
  assert.equal((await listValidPublicEvents({ store, libraryId: config.libraryId })).length, 0);
  const after = await queueFor(store);
  assert.equal(after.total, 1);
  assert.equal(after.items[0].candidateUnitPrice, 105);
  assert.equal(keysWithPrefix(store, 'audit/').length, 1);
  const replay = await mutateAdminReview({
    store,
    config,
    identity: IDENTITY,
    command: command('reject', input),
    now: NOW + 201,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(keysWithPrefix(store, 'audit/').length, 1);
});

test('edit-and-approve changes only unitPrice, publishes the edited hash, and leaves candidates immutable', async () => {
  const { store, first } = await seedConflict();
  const config = readAdminReviewMutationConfig(ENV);
  const beforeCandidate = structuredClone(store.values.get(pendingSubmissionKey(first.libraryId, first.idempotencyKey)));
  const selected = (await queueFor(store)).items.find(item => item.candidateUnitPrice === 100);
  const result = await mutateAdminReview({
    store,
    config,
    identity: IDENTITY,
    command: command('edit_and_approve', {
      reviewId: selected.reviewId,
      confirmation: 'EDIT_AND_APPROVE',
      unitPrice: 102.5,
    }),
    now: NOW + 300,
  });
  assert.equal(result.status, 'edited_and_approved');
  assert.notEqual(result.targetContentHash, selected.contentHash);
  const snapshot = await buildPublicSnapshot({
    store,
    groupId: config.groupId,
    libraryId: config.libraryId,
    now: NOW + 301,
  });
  assert.equal(snapshot.publicVersion, 1);
  assert.equal(snapshot.records[0].payload.serviceName, first.payload.serviceName);
  assert.equal(snapshot.records[0].payload.settleType, first.payload.settleType);
  assert.equal(snapshot.records[0].payload.unitPrice, 102.5);
  assert.deepEqual(store.values.get(pendingSubmissionKey(first.libraryId, first.idempotencyKey)), beforeCandidate);
  await expectMutationCode('ADMIN_REVIEW_EDIT_NO_CHANGE', async () => {
    const seeded = await seedConflict();
    const target = (await queueFor(seeded.store)).items.find(item => item.candidateUnitPrice === 100);
    await mutateAdminReview({
      store: seeded.store,
      config,
      identity: IDENTITY,
      command: command('edit_and_approve', {
        reviewId: target.reviewId,
        confirmation: 'EDIT_AND_APPROVE',
        unitPrice: 100,
      }),
      now: NOW + 302,
    });
  });
});

test('two concurrent approvals in one baseline cycle cannot both publish', async () => {
  const { store } = await seedConflict();
  const config = readAdminReviewMutationConfig(ENV);
  const items = (await queueFor(store)).items;
  const attempts = await Promise.allSettled(items.map((item, index) => mutateAdminReview({
    store,
    config,
    identity: IDENTITY,
    command: command('approve', { reviewId: item.reviewId, confirmation: 'APPROVE' }),
    now: NOW + 400 + index,
  })));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = attempts.find(item => item.status === 'rejected');
  assert.equal(rejected.reason.code, 'ADMIN_REVIEW_BASELINE_ALREADY_CLAIMED');
  assert.equal((await listValidPublicEvents({ store, libraryId: config.libraryId })).length, 1);
});

test('an interruption after public publication recovers without a second event', async () => {
  const { store } = await seedConflict();
  const config = readAdminReviewMutationConfig(ENV);
  const selected = (await queueFor(store)).items.find(item => item.candidateUnitPrice === 100);
  const input = { reviewId: selected.reviewId, confirmation: 'APPROVE' };
  store.failPrefixOnce = 'audit/';
  await assert.rejects(() => mutateAdminReview({
    store,
    config,
    identity: IDENTITY,
    command: command('approve', input),
    now: NOW + 500,
  }));
  assert.equal((await listValidPublicEvents({ store, libraryId: config.libraryId })).length, 1);
  assert.equal(keysWithPrefix(store, 'audit/').length, 0);
  const recovered = await mutateAdminReview({
    store,
    config,
    identity: IDENTITY,
    command: command('approve', input),
    now: NOW + 9000,
  });
  assert.equal(recovered.status, 'approved_by_admin');
  assert.equal((await listValidPublicEvents({ store, libraryId: config.libraryId })).length, 1);
  assert.equal(keysWithPrefix(store, 'audit/').length, 1);
  assert.equal((await queueFor(store)).total, 0);
});

test('a resolution without its immutable audit fails the read queue closed', async () => {
  const { store } = await seedConflict();
  const config = readAdminReviewMutationConfig(ENV);
  const selected = (await queueFor(store)).items.find(item => item.candidateUnitPrice === 100);
  await mutateAdminReview({
    store,
    config,
    identity: IDENTITY,
    command: command('approve', { reviewId: selected.reviewId, confirmation: 'APPROVE' }),
    now: NOW + 550,
  });
  const [auditKey] = keysWithPrefix(store, 'audit/');
  store.values.delete(auditKey);
  await assert.rejects(
    () => queueFor(store),
    error => error?.code === 'ADMIN_REVIEW_INVALID_AUDIT',
  );
});

test('stale public baselines fail before a decision claim or audit is written', async () => {
  const { store } = await seedConflict();
  const config = readAdminReviewMutationConfig(ENV);
  const queue = await queueFor(store);
  const firstItem = queue.items.find(item => item.candidateUnitPrice === 100);
  const secondItem = queue.items.find(item => item.candidateUnitPrice === 105);
  const target = await getAdminReviewMutationTarget({ store, config, reviewId: firstItem.reviewId });
  await publishAdminReviewApproval({
    store,
    submission: target.submission,
    baseline: {
      approvedVersion: target.baseline.approvedVersion,
      contentHash: target.baseline.contentHash,
      unitPrice: target.baseline.unitPrice,
    },
    approvalMode: 'admin_approved',
    evidence: target.evidence,
    now: NOW + 600,
  });
  await expectMutationCode('ADMIN_REVIEW_STALE_BASELINE', () => mutateAdminReview({
    store,
    config,
    identity: IDENTITY,
    command: command('approve', { reviewId: secondItem.reviewId, confirmation: 'APPROVE' }),
    now: NOW + 601,
  }));
  assert.equal(keysWithPrefix(store, `reviews/${config.libraryId}/decisions/`).length, 0);
  assert.equal(keysWithPrefix(store, 'audit/').length, 0);
});

test('HTTP mutations require authenticated same-origin JSON and expose only isolated mutation capabilities', async () => {
  const { store } = await seedConflict();
  const selected = (await queueFor(store)).items.find(item => item.candidateUnitPrice === 100);
  let stores = 0;
  const dependencies = {
    now: () => NOW,
    createStore: env => {
      stores += 1;
      assert.equal(env.CLOUD_BLOB_STORE_NAME, ADMIN_REVIEW_PREVIEW_STORE_NAME);
      return store;
    },
  };
  const denied = await handleAdminReviewApproveRequest({
    env: ENV,
    request: request('/api/admin/reviews/approve', {
      cookie: null,
      body: { reviewId: selected.reviewId, confirmation: 'APPROVE' },
    }),
  }, dependencies);
  assert.equal(denied.status, 401);
  assert.equal(stores, 0);
  assert.match(denied.headers.get('set-cookie'), /Max-Age=0/);

  const crossOrigin = await handleAdminReviewApproveRequest({
    env: ENV,
    request: request('/api/admin/reviews/approve', {
      origin: 'https://evil.example',
      body: { reviewId: selected.reviewId, confirmation: 'APPROVE' },
    }),
  }, dependencies);
  assert.equal(crossOrigin.status, 403);
  assert.equal(stores, 0);

  const wrongType = await handleAdminReviewApproveRequest({
    env: ENV,
    request: request('/api/admin/reviews/approve', {
      contentType: 'text/plain',
      body: JSON.stringify({ reviewId: selected.reviewId, confirmation: 'APPROVE' }),
    }),
  }, dependencies);
  assert.equal(wrongType.status, 415);
  assert.equal(stores, 0);

  const get = await handleAdminReviewApproveRequest({
    env: ENV,
    request: request('/api/admin/reviews/approve', { method: 'GET', body: null, contentType: null }),
  }, dependencies);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');

  const response = await handleAdminReviewApproveRequest({
    env: ENV,
    request: request('/api/admin/reviews/approve', {
      body: { reviewId: selected.reviewId, confirmation: 'APPROVE' },
    }),
  }, dependencies);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  const text = await response.text();
  const payload = JSON.parse(text);
  assert.deepEqual(payload.data.capabilities, ADMIN_REVIEW_MUTATION_CAPABILITIES);
  assert.equal(payload.data.result.status, 'approved_by_admin');
  assert.equal(payload.data.result.publicVersion, 1);
  assert.equal(isAdminReviewMutationProjectionSafe(payload.data), true);
  for (const forbidden of [DEVICE_A, DEVICE_B, SUB_A, SUB_B, 'reviews/', 'submissions/', 'audit/']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('Stage5C page, routes, and environment remain isolated from ordinary users and default closed', async () => {
  const env = fs.readFileSync('.env.example', 'utf8');
  const page = fs.readFileSync('dist/admin-review-actions-preview.html', 'utf8');
  const userSource = fs.readFileSync('src/码单器8.2.26_公共协作本地候选版.html', 'utf8');
  const userOutput = fs.readFileSync('dist/index.html', 'utf8');
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.match(env, /^CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED=0$/m);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
  assert.match(page, /\/api\/admin\/reviews\/approve/);
  assert.match(page, /\/api\/admin\/reviews\/reject/);
  assert.match(page, /\/api\/admin\/reviews\/edit-and-approve/);
  assert.doesNotMatch(page, /(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)/);
  assert.doesNotMatch(page, /indexedDB\.(?:open|deleteDatabase)/);
  assert.doesNotMatch(page, /CLOUD_ADMIN_(?:PASSWORD|SESSION_SECRET|RATE_LIMIT_SALT)/);
  assert.doesNotMatch(page, /\/api\/(?:submissions|preview)\//);
  assert.doesNotMatch(userSource, /admin-review-actions-preview|\/api\/admin\/reviews\/(?:approve|reject|edit-and-approve)/);
  assert.doesNotMatch(userOutput, /admin-review-actions-preview|\/api\/admin\/reviews\/(?:approve|reject|edit-and-approve)/);

  const routeFiles = [
    'cloud-functions/api/admin/reviews/approve.js',
    'cloud-functions/api/admin/reviews/reject.js',
    'cloud-functions/api/admin/reviews/edit-and-approve.js',
  ];
  for (const file of routeFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /admin_review_mutation_http_v1/);
  }
  const modules = await Promise.all(routeFiles.map(file => import(`../${file}`)));
  assert.ok(modules.every(module => typeof module.default === 'function'));
  assert.equal(typeof handleAdminReviewRejectRequest, 'function');
  assert.equal(typeof handleAdminReviewEditAndApproveRequest, 'function');
  assert.equal(AdminReviewMutationError.prototype instanceof Error, true);
});
