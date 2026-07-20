import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSensitiveSubmissionHashes } from '../src/server/sensitive_rules_policy_v1.js';
import { acceptSensitiveSubmission } from '../src/server/sensitive_submission_acceptance_v1.js';

const NOW = 1_784_570_000_000;
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';

class MemoryBlobStore {
  constructor() { this.values = new Map(); }
  clone(value) { return value === null || value === undefined ? value : structuredClone(value); }
  async get(key) { return this.values.has(key) ? this.clone(this.values.get(key)) : null; }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.values.set(key, this.clone(value));
  }
  async delete(key) { this.values.delete(key); }
}

function draft(dataType, payload, overrides = {}) {
  return {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId: SUB_A,
    deviceId: DEVICE_A,
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
    clientContext: {
      appVersion: '8.2.30-stage6a',
      projectionSpecVersion: 1,
      queueSchemaVersion: 1,
    },
    ...overrides,
  };
}

function complete(raw) {
  const computed = computeSensitiveSubmissionHashes(raw);
  return {
    ...raw,
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    idempotencyKey: computed.idempotencyKey,
  };
}

function authenticateAs(deviceId = DEVICE_A) {
  return async () => ({ deviceId, tokenVersion: 1, expiresAt: NOW + 60_000 });
}

function gift(unitPrice = 66, overrides = {}) {
  return complete(draft('gift_rule', {
    serviceName: '红包',
    mode: 'fixed',
    unitPrice,
  }, overrides));
}

test('Stage6A immutable acceptance stores pending review and replays idempotently', async () => {
  const store = new MemoryBlobStore();
  const submission = gift();
  const first = await acceptSensitiveSubmission({
    store,
    authorization: 'Bearer synthetic',
    rawSubmission: submission,
    now: NOW,
    authenticate: authenticateAs(),
  });
  assert.equal(first.status, 'pending_review');
  assert.equal(first.decision, 'pending_review');
  assert.equal(first.reason, 'gift_rule_manual_review');
  assert.equal(first.duplicate, false);
  assert.equal(first.stored, true);
  assert.equal(first.publicMutationAllowed, false);
  assert.equal(first.autoApprovalEnabled, false);

  const replay = await acceptSensitiveSubmission({
    store,
    authorization: 'Bearer synthetic',
    rawSubmission: submission,
    now: NOW + 1000,
    authenticate: authenticateAs(),
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.receivedAt, NOW);
  assert.equal(store.values.size, 1);
});

test('Stage6A reused idempotency key with a different normalized body fails closed', async () => {
  const store = new MemoryBlobStore();
  const first = gift(66);
  await acceptSensitiveSubmission({
    store,
    authorization: 'Bearer synthetic',
    rawSubmission: first,
    now: NOW,
    authenticate: authenticateAs(),
  });
  const changed = gift(88);
  assert.equal(changed.idempotencyKey, first.idempotencyKey);
  await assert.rejects(
    () => acceptSensitiveSubmission({
      store,
      authorization: 'Bearer synthetic',
      rawSubmission: changed,
      now: NOW + 1000,
      authenticate: authenticateAs(),
    }),
    error => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409,
  );
});

test('Stage6A acceptance binds Authorization identity to submission device', async () => {
  const store = new MemoryBlobStore();
  await assert.rejects(
    () => acceptSensitiveSubmission({
      store,
      authorization: 'Bearer synthetic',
      rawSubmission: gift(),
      now: NOW,
      authenticate: authenticateAs(DEVICE_B),
    }),
    error => error.code === 'DEVICE_SCOPE_MISMATCH' && error.status === 403,
  );
  assert.equal(store.values.size, 0);
});

test('Stage6A explicit delete resolves a public baseline before immutable acceptance', async () => {
  const store = new MemoryBlobStore();
  const submission = complete(draft('exact_price', null, {
    operation: 'delete',
    businessKey: `bk_v1_${'D'.repeat(43)}`,
  }));
  const baseline = {
    businessKey: submission.businessKey,
    contentHash: `ch_v1_${'E'.repeat(43)}`,
    dataType: 'exact_price',
    bossId: null,
    payload: { serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 88 },
  };
  const result = await acceptSensitiveSubmission({
    store,
    authorization: 'Bearer synthetic',
    rawSubmission: submission,
    resolveExistingRecord: async query => {
      assert.deepEqual(query, {
        groupId: GROUP,
        libraryId: LIBRARY,
        dataType: 'exact_price',
        businessKey: submission.businessKey,
        bossId: null,
      });
      return baseline;
    },
    now: NOW,
    authenticate: authenticateAs(),
  });
  assert.equal(result.status, 'pending_review');
  assert.equal(result.reason, 'explicit_delete_manual_review');
  assert.equal(store.values.size, 1);

  await assert.rejects(
    () => acceptSensitiveSubmission({
      store: new MemoryBlobStore(),
      authorization: 'Bearer synthetic',
      rawSubmission: submission,
      resolveExistingRecord: async () => null,
      now: NOW,
      authenticate: authenticateAs(),
    }),
    error => error.code === 'DELETE_TARGET_NOT_FOUND' && error.status === 400,
  );
});
