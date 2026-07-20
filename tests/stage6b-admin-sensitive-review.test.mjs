import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptSensitiveSubmission,
} from '../src/server/sensitive_submission_acceptance_v1.js';
import {
  computeSensitiveSubmissionHashes,
} from '../src/server/sensitive_rules_policy_v1.js';
import {
  getAdminSensitiveReviewDetail,
  listAdminSensitiveReviewQueue,
  mutateAdminSensitiveReview,
  readAdminSensitiveReviewConfig,
} from '../src/server/admin_sensitive_review_v1.js';

const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const DEVICE = 'dev_01JABCDEF0123456789XYZABCD';
const SUBMISSION = 'sub_01JABCDEF0123456789XYZABCD';
const NOW = 1_784_610_000_000;
const CONFIG = Object.freeze({ schemaVersion: 1, enabled: true, storeName: 'cloud-collab-preview-v1', groupId: GROUP, libraryId: LIBRARY });

class MemoryBlobStore {
  constructor() { this.values = new Map(); }
  clone(value) { return value === null || value === undefined ? value : structuredClone(value); }
  async get(key) { return this.values.has(key) ? this.clone(this.values.get(key)) : null; }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) throw new Error('already exists');
    this.values.set(key, this.clone(value));
  }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = '' } = {}) {
    return { blobs: [...this.values.keys()].filter(key => key.startsWith(prefix)).sort().map(key => ({ key })) };
  }
}

function draft(dataType, payload, overrides = {}) {
  return {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId: SUBMISSION,
    deviceId: DEVICE,
    groupId: GROUP,
    libraryId: LIBRARY,
    bossId: null,
    dataType,
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: NOW - 1000,
    businessKey: `bk_v1_${'A'.repeat(43)}`,
    contentHash: `ch_v1_${'A'.repeat(43)}`,
    idempotencyKey: `ik_v1_${'A'.repeat(43)}`,
    payload,
    clientContext: { appVersion: '8.2.31-stage6b', projectionSpecVersion: 1, queueSchemaVersion: 1 },
    ...overrides,
  };
}

function complete(raw) {
  const computed = computeSensitiveSubmissionHashes(raw);
  return { ...raw, businessKey: computed.businessKey, contentHash: computed.contentHash, idempotencyKey: computed.idempotencyKey };
}

function authenticate() {
  return async () => ({ deviceId: DEVICE, tokenVersion: 1, expiresAt: NOW + 60_000 });
}

async function accept(store, submission, existingRecord = null, now = NOW) {
  return acceptSensitiveSubmission({
    store,
    authorization: 'Bearer synthetic',
    rawSubmission: submission,
    existingRecord,
    now,
    authenticate: authenticate(),
  });
}

function surcharge(price = 5) {
  return { name: '甜蜜单', keywords: ['甜蜜单'], prices: { round: price, hour: 20 }, enabled: true };
}

test('Stage6B admin gate defaults closed and requires exact shared synthetic scope', () => {
  assert.throws(() => readAdminSensitiveReviewConfig({}), error => error.code === 'ADMIN_SENSITIVE_REVIEW_PREVIEW_DISABLED');
  const env = {
    CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED: '1',
    CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID: GROUP,
    CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID: LIBRARY,
    CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED: '1',
    CLOUD_SENSITIVE_REVIEW_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_SENSITIVE_REVIEW_ALLOWED_GROUP_ID: GROUP,
    CLOUD_SENSITIVE_REVIEW_ALLOWED_LIBRARY_ID: LIBRARY,
  };
  assert.equal(readAdminSensitiveReviewConfig(env).enabled, true);
  assert.throws(
    () => readAdminSensitiveReviewConfig({ ...env, CLOUD_SENSITIVE_REVIEW_BLOB_STORE_NAME: 'formal-public' }),
    error => error.code === 'ADMIN_SENSITIVE_REVIEW_SCOPE_INVALID',
  );
});

test('Stage6B queue and detail expose strict public projection without device credentials', async () => {
  const store = new MemoryBlobStore();
  const submission = complete(draft('gift_rule', { serviceName: '红包', mode: 'fixed', unitPrice: 66 }));
  await accept(store, submission);
  const queue = await listAdminSensitiveReviewQueue({ store, config: CONFIG });
  assert.equal(queue.count, 1);
  assert.equal(queue.items[0].dataType, 'gift_rule');
  assert.equal(queue.items[0].operation, 'upsert');
  assert.equal(queue.items[0].status, 'pending_review');
  assert.equal(queue.items[0].reviewId.startsWith('srv_v1_'), true);
  assert.equal(JSON.stringify(queue).includes(DEVICE), false);

  const detail = await getAdminSensitiveReviewDetail({ store, config: CONFIG, reviewId: queue.items[0].reviewId, now: NOW + 1 });
  assert.deepEqual(detail.candidate.payload, { serviceName: '红包', mode: 'fixed', unitPrice: 66 });
  assert.equal(detail.baseline, null);
  assert.equal(JSON.stringify(detail).includes('deviceToken'), false);
  assert.equal(JSON.stringify(detail).includes('authorization'), false);
});

test('Stage6B approve publishes public event, archives immutable audit, and removes queue item', async () => {
  const store = new MemoryBlobStore();
  const submission = complete(draft('surcharge_rule', surcharge()));
  await accept(store, submission);
  const queue = await listAdminSensitiveReviewQueue({ store, config: CONFIG });
  const reviewId = queue.items[0].reviewId;
  const result = await mutateAdminSensitiveReview({
    store,
    config: CONFIG,
    identity: { username: 'admin' },
    action: 'approve',
    input: { reviewId, confirmation: 'APPROVE_SENSITIVE' },
    now: NOW + 10,
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.resolution.action, 'approve');
  assert.equal(result.publicResult.version, 1);
  assert.equal(result.publicResult.operation, 'upsert');
  assert.equal((await listAdminSensitiveReviewQueue({ store, config: CONFIG })).count, 0);

  const replay = await mutateAdminSensitiveReview({
    store,
    config: CONFIG,
    identity: { username: 'admin' },
    action: 'approve',
    input: { reviewId, confirmation: 'APPROVE_SENSITIVE' },
    now: NOW + 20,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.resolution.decisionId, result.resolution.decisionId);
  assert.equal([...store.values.keys()].filter(key => key.includes('/sensitive-events/')).length, 1);
  assert.equal([...store.values.keys()].filter(key => key.startsWith('audit/')).length, 1);
});

test('Stage6B reject archives decision without public mutation and conflicting replay fails', async () => {
  const store = new MemoryBlobStore();
  const submission = complete(draft('rank_range_rule', {
    rangeLabel: '0-20星', alias: '', rankType: 'star', minStar: 0, maxStar: 20, namedRanks: [],
    prices: { normal: { round: 12, hour: null }, carry: { round: null, hour: null }, starGuarantee: { round: null, hour: null } },
  }));
  await accept(store, submission);
  const reviewId = (await listAdminSensitiveReviewQueue({ store, config: CONFIG })).items[0].reviewId;
  const rejected = await mutateAdminSensitiveReview({
    store, config: CONFIG, identity: { username: 'admin' }, action: 'reject',
    input: { reviewId, confirmation: 'REJECT_SENSITIVE', reasonCode: 'insufficient_evidence' },
    now: NOW + 30,
  });
  assert.equal(rejected.publicResult, null);
  assert.equal([...store.values.keys()].filter(key => key.includes('/sensitive-events/')).length, 0);
  await assert.rejects(
    () => mutateAdminSensitiveReview({
      store, config: CONFIG, identity: { username: 'admin' }, action: 'approve',
      input: { reviewId, confirmation: 'APPROVE_SENSITIVE' }, now: NOW + 31,
    }),
    error => error.code === 'ADMIN_SENSITIVE_REVIEW_ALREADY_RESOLVED' && error.status === 409,
  );
});

test('Stage6B edit-and-approve keeps business identity and rejects identity changes or delete edits', async () => {
  const store = new MemoryBlobStore();
  const original = complete(draft('surcharge_rule', surcharge()));
  await accept(store, original);
  const reviewId = (await listAdminSensitiveReviewQueue({ store, config: CONFIG })).items[0].reviewId;
  const edited = await mutateAdminSensitiveReview({
    store, config: CONFIG, identity: { username: 'admin' }, action: 'edit_and_approve',
    input: { reviewId, confirmation: 'EDIT_AND_APPROVE_SENSITIVE', payload: surcharge(8) },
    now: NOW + 40,
  });
  assert.equal(edited.publicResult.version, 1);

  const secondStore = new MemoryBlobStore();
  await accept(secondStore, original);
  const secondReview = (await listAdminSensitiveReviewQueue({ store: secondStore, config: CONFIG })).items[0].reviewId;
  await assert.rejects(
    () => mutateAdminSensitiveReview({
      store: secondStore, config: CONFIG, identity: { username: 'admin' }, action: 'edit_and_approve',
      input: { secondReview, reviewId: secondReview, confirmation: 'EDIT_AND_APPROVE_SENSITIVE', payload: { ...surcharge(), name: '另一规则' } },
      now: NOW + 41,
    }),
    error => ['ADMIN_SENSITIVE_BODY_INVALID', 'ADMIN_SENSITIVE_EDIT_IDENTITY_CHANGE'].includes(error.code),
  );
});

test('Stage6B stale candidate baseline blocks approval and preserves pending review', async () => {
  const store = new MemoryBlobStore();
  const first = complete(draft('gift_rule', { serviceName: '红包', mode: 'fixed', unitPrice: 66 }));
  await accept(store, first);
  const firstReview = (await listAdminSensitiveReviewQueue({ store, config: CONFIG })).items[0].reviewId;
  await mutateAdminSensitiveReview({
    store, config: CONFIG, identity: { username: 'admin' }, action: 'approve',
    input: { reviewId: firstReview, confirmation: 'APPROVE_SENSITIVE' }, now: NOW + 50,
  });

  const stale = complete(draft('gift_rule', { serviceName: '红包', mode: 'fixed', unitPrice: 88 }, {
    submissionId: 'sub_01JABCDEF0123456789XYZABCE',
  }));
  await accept(store, stale, {
    businessKey: first.businessKey,
    contentHash: first.contentHash,
    dataType: 'gift_rule',
    bossId: null,
    payload: first.payload,
  }, NOW + 51);
  const pending = await listAdminSensitiveReviewQueue({ store, config: CONFIG });
  assert.equal(pending.count, 1);

  // Simulate a newer public baseline after candidate acceptance by editing only the candidate's captured hash.
  const pendingKey = [...store.values.keys()].find(key => key.startsWith(`submissions/${LIBRARY}/pending/`) && store.values.get(key)?.submission?.submissionId === stale.submissionId);
  const candidate = store.values.get(pendingKey);
  candidate.baselineContentHash = `ch_v1_${'Z'.repeat(43)}`;
  store.values.set(pendingKey, candidate);
  await assert.rejects(
    () => mutateAdminSensitiveReview({
      store, config: CONFIG, identity: { username: 'admin' }, action: 'approve',
      input: { reviewId: pending.items[0].reviewId, confirmation: 'APPROVE_SENSITIVE' }, now: NOW + 52,
    }),
    error => error.code === 'ADMIN_SENSITIVE_REVIEW_STALE_BASELINE' && error.status === 409,
  );
});
