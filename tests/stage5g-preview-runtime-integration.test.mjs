import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptAndReviewPreviewSubmission,
  readPreviewAutoApprovalConfig,
  readPreviewPublicEvents,
  readPreviewPublicSnapshot,
} from '../src/server/preview_auto_approval_runtime_v1.js';
import { computeOrdinarySubmissionHashes } from '../src/server/ordinary_types_policy_v1.js';

const NOW = 1_784_530_000_000;
const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_B = 'sub_01JABCDEF0123456789XYZABCE';

const BASE_ENV = Object.freeze({
  CLOUD_WRITE_PREVIEW_ENABLED: '1',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '1',
  CLOUD_WRITE_PREVIEW_KEY: 'stage5g-runtime-write-key-012345678901234',
  CLOUD_WRITE_ALLOWED_GROUP_ID: GROUP,
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: LIBRARY,
  CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_RATE_LIMIT_SALT: 'stage5g-runtime-rate-salt-01234567890123',
});
const ORDINARY_ENV = Object.freeze({
  ...BASE_ENV,
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

  async delete(key) {
    this.values.delete(key);
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

function draft(dataType, payload, { deviceId, submissionId } = {}) {
  return {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId: submissionId || SUB_A,
    deviceId: deviceId || DEVICE_A,
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

function authenticate(deviceId) {
  return async () => ({
    deviceId,
    tokenVersion: 1,
    expiresAt: NOW + 60_000,
  });
}

const neverTrusted = async () => false;
const alwaysTrusted = async () => true;

test('Stage5G gate-on runtime accepts, reviews and reads playable names through the mixed public chain', async () => {
  const store = new MemoryBlobStore();
  const first = complete(draft('playable_name', { name: '小明' }, {
    deviceId: DEVICE_A,
    submissionId: SUB_A,
  }));
  const second = complete(draft('playable_name', { name: '小明' }, {
    deviceId: DEVICE_B,
    submissionId: SUB_B,
  }));

  const waiting = await acceptAndReviewPreviewSubmission({
    store,
    authorization: 'Bearer first',
    rawSubmission: first,
    env: ORDINARY_ENV,
    now: NOW,
    authenticate: authenticate(DEVICE_A),
    trustedDeviceResolver: neverTrusted,
  });
  assert.equal(waiting.status, 'waiting_confirmation');
  assert.equal(waiting.dataType, 'playable_name');
  assert.equal(waiting.previewOrdinaryTypesEnabled, true);
  assert.equal(waiting.previewMutationApplied, false);

  const approved = await acceptAndReviewPreviewSubmission({
    store,
    authorization: 'Bearer second',
    rawSubmission: second,
    env: ORDINARY_ENV,
    now: NOW + 1000,
    authenticate: authenticate(DEVICE_B),
    trustedDeviceResolver: neverTrusted,
  });
  assert.equal(approved.status, 'auto_approved');
  assert.equal(approved.previewPublicVersion, 1);
  assert.equal(approved.previewMutationApplied, true);

  const snapshot = await readPreviewPublicSnapshot({
    store,
    env: ORDINARY_ENV,
    groupId: GROUP,
    libraryId: LIBRARY,
    now: NOW + 2000,
  });
  assert.equal(snapshot.publicVersion, 1);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].dataType, 'playable_name');
  assert.deepEqual(snapshot.records[0].payload, { name: '小明' });

  const events = await readPreviewPublicEvents({
    store,
    env: ORDINARY_ENV,
    groupId: GROUP,
    libraryId: LIBRARY,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].dataType, 'playable_name');
});

test('Stage5G gate-off runtime preserves the frozen exact config and response shape', async () => {
  const store = new MemoryBlobStore();
  const config = readPreviewAutoApprovalConfig(BASE_ENV);
  assert.equal(Object.hasOwn(config, 'ordinaryTypesEnabled'), false);

  const exact = complete(draft('exact_price', {
    serviceName: '鹅鸭杀',
    settleType: 'round',
    unitPrice: 88,
  }));
  const approved = await acceptAndReviewPreviewSubmission({
    store,
    authorization: 'Bearer exact',
    rawSubmission: exact,
    env: BASE_ENV,
    now: NOW,
    authenticate: authenticate(DEVICE_A),
    trustedDeviceResolver: alwaysTrusted,
  });
  assert.equal(approved.status, 'auto_approved');
  assert.equal(approved.previewPublicVersion, 1);
  assert.equal(Object.hasOwn(approved, 'dataType'), false);
  assert.equal(Object.hasOwn(approved, 'previewOrdinaryTypesEnabled'), false);

  const playable = complete(draft('playable_name', { name: '小明' }));
  await assert.rejects(
    () => acceptAndReviewPreviewSubmission({
      store,
      authorization: 'Bearer blocked',
      rawSubmission: playable,
      env: BASE_ENV,
      now: NOW + 6000,
      authenticate: authenticate(DEVICE_A),
      trustedDeviceResolver: alwaysTrusted,
    }),
    error => error.code === 'UNSUPPORTED_DATA_TYPE' && error.status === 400,
  );
});
