import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeOrdinarySubmissionHashes,
} from '../src/server/ordinary_types_policy_v1.js';
import {
  acceptOrdinarySubmission,
} from '../src/server/ordinary_submission_acceptance_v1.js';
import {
  acceptPreviewOrdinarySubmission,
  readOrdinaryTypesRuntimeConfig,
} from '../src/server/ordinary_types_preview_runtime_v1.js';

const NOW = 1_784_510_000_000;
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_B = 'sub_01JABCDEF0123456789XYZABCE';
const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const ENV = Object.freeze({
  CLOUD_WRITE_PREVIEW_ENABLED: '1',
  CLOUD_WRITE_PREVIEW_KEY: 'stage5g-write-preview-key-012345678901234',
  CLOUD_WRITE_ALLOWED_GROUP_ID: GROUP,
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: LIBRARY,
  CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_RATE_LIMIT_SALT: 'stage5g-rate-limit-salt-012345678901234',
  CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED: '1',
  CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ORDINARY_TYPES_ALLOWED_GROUP_ID: GROUP,
  CLOUD_ORDINARY_TYPES_ALLOWED_LIBRARY_ID: LIBRARY,
});

class MemoryBlobStore {
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

  async list({ prefix = '' } = {}) {
    return {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
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
      appVersion: '8.2.28-stage5g',
      projectionSpecVersion: 1,
      queueSchemaVersion: 1,
    },
    ...overrides,
  };
}

function complete(raw) {
  const computed = computeOrdinarySubmissionHashes(raw);
  return {
    ...raw,
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    idempotencyKey: computed.idempotencyKey,
  };
}

function authenticateAs(deviceId = DEVICE_A) {
  return async () => ({
    deviceId,
    tokenVersion: 1,
    expiresAt: NOW + 60_000,
  });
}

test('Stage5G immutable acceptance stores a strict ordinary candidate and returns idempotent replay', async () => {
  const store = new MemoryBlobStore();
  const submission = complete(draft('playable_name', { name: '小明' }));
  const first = await acceptOrdinarySubmission({
    store,
    authorization: 'Bearer synthetic',
    rawSubmission: submission,
    now: NOW,
    authenticate: authenticateAs(),
  });
  assert.equal(first.dataType, 'playable_name');
  assert.equal(first.status, 'waiting_confirmation');
  assert.equal(first.decision, 'waiting_confirmation');
  assert.equal(first.duplicate, false);
  assert.equal(first.publicMutationAllowed, false);
  assert.equal(first.autoApprovalEnabled, false);

  const second = await acceptOrdinarySubmission({
    store,
    authorization: 'Bearer synthetic',
    rawSubmission: submission,
    now: NOW + 1000,
    authenticate: authenticateAs(),
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.receivedAt, NOW);
  assert.equal([...store.values.keys()].filter(key => key.startsWith(`submissions/${LIBRARY}/pending/`)).length, 1);
});

test('Stage5G same idempotency key with different normalized body fails closed', async () => {
  const store = new MemoryBlobStore();
  const first = complete(draft('playable_name', { name: '小明' }));
  await acceptOrdinarySubmission({
    store,
    authorization: 'Bearer synthetic',
    rawSubmission: first,
    now: NOW,
    authenticate: authenticateAs(),
  });
  const changed = complete(draft('playable_name', { name: '小红' }));
  assert.equal(changed.idempotencyKey, first.idempotencyKey);
  await assert.rejects(
    () => acceptOrdinarySubmission({
      store,
      authorization: 'Bearer synthetic',
      rawSubmission: changed,
      now: NOW + 1000,
      authenticate: authenticateAs(),
    }),
    error => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409,
  );
});

test('Stage5G acceptance binds Authorization identity to submission device', async () => {
  const store = new MemoryBlobStore();
  const submission = complete(draft('boss_profile', {
    bossName: '老板甲',
    paiDan: '直属A',
    discount: 0.97,
  }));
  await assert.rejects(
    () => acceptOrdinarySubmission({
      store,
      authorization: 'Bearer synthetic',
      rawSubmission: submission,
      now: NOW,
      authenticate: authenticateAs(DEVICE_B),
    }),
    error => error.code === 'DEVICE_SCOPE_MISMATCH' && error.status === 403,
  );
  assert.equal(store.values.size, 0);
});

test('Stage5G runtime requires both write and ordinary gates with exactly the same fixture store and scope', () => {
  assert.throws(
    () => readOrdinaryTypesRuntimeConfig({ ...ENV, CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED: '0' }),
    error => error.code === 'ORDINARY_TYPES_PREVIEW_DISABLED',
  );
  assert.throws(
    () => readOrdinaryTypesRuntimeConfig({ ...ENV, CLOUD_BLOB_STORE_NAME: 'other-store' }),
    error => error.code === 'ORDINARY_TYPES_STORE_MISMATCH',
  );
  assert.equal(readOrdinaryTypesRuntimeConfig(ENV).ordinaryTypesEnabled, true);
});

test('Stage5G runtime applies a dedicated rate slot but skips it for exact replay', async () => {
  const store = new MemoryBlobStore();
  const first = complete(draft('playable_name', { name: '小明' }));
  const firstResult = await acceptPreviewOrdinarySubmission({
    store,
    authorization: 'Bearer synthetic',
    rawSubmission: first,
    env: ENV,
    now: NOW,
    authenticate: authenticateAs(),
  });
  assert.equal(firstResult.duplicate, false);

  const replay = await acceptPreviewOrdinarySubmission({
    store,
    authorization: 'Bearer synthetic',
    rawSubmission: first,
    env: ENV,
    now: NOW + 100,
    authenticate: authenticateAs(),
  });
  assert.equal(replay.duplicate, true);

  const second = complete(draft('playable_name', { name: '小红' }, {
    submissionId: SUB_B,
  }));
  await assert.rejects(
    () => acceptPreviewOrdinarySubmission({
      store,
      authorization: 'Bearer synthetic',
      rawSubmission: second,
      env: ENV,
      now: NOW + 200,
      authenticate: authenticateAs(),
    }),
    error => error.code === 'PREVIEW_RATE_LIMITED' && error.status === 429,
  );
});
