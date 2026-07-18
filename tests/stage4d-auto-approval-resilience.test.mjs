import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublicSnapshot,
  listValidPublicEvents,
  reviewExactPriceCandidate,
  trustedDeviceKey,
} from '../src/server/auto_approval_v1.js';
import { buildIdempotencyKey, computeSubmissionHashes } from '../src/server/submission_policy_v1.js';

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.failOncePrefixes = [];
  }

  clone(value) {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  failNextSet(prefix) {
    this.failOncePrefixes.push(prefix);
  }

  async get(key) {
    return this.values.has(key) ? this.clone(this.values.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    const index = this.failOncePrefixes.findIndex(prefix => key.startsWith(prefix));
    if (index >= 0) {
      this.failOncePrefixes.splice(index, 1);
      const error = new Error(`injected failure for ${key}`);
      error.code = 'INJECTED_WRITE_FAILURE';
      throw error;
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

  async list({ prefix = '' } = {}) {
    return {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key, etag: `etag-${key.length}` })),
    };
  }
}

const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const DEVICE_C = 'dev_01JABCDEF0123456789XYZABCF';
const SUB_A1 = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_A2 = 'sub_01JABCDEF0123456789XYZABCE';
const SUB_B1 = 'sub_01JABCDEF0123456789XYZABCF';
const SUB_C1 = 'sub_01JABCDEF0123456789XYZABCG';
const NOW = 1784405000000;

function rawSubmission({ deviceId, submissionId, serviceName = '测试服务A', unitPrice = 110 }) {
  const value = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId: 'group_fixture',
    libraryId: 'lib_receive_fixture',
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

function candidate(submission, receivedAt) {
  return {
    schemaVersion: 1,
    requestHash: 'req_v1_0000000000000000000000000000000000000000000',
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

async function trust(store, deviceId) {
  await store.setJSON(trustedDeviceKey(deviceId), {
    schemaVersion: 1,
    deviceId,
    trusted: true,
    trustedAt: NOW,
    revokedAt: null,
  });
}

function countPrefix(store, prefix) {
  return [...store.values.keys()].filter(key => key.startsWith(prefix)).length;
}

test('concurrent matching confirmations produce one valid approval even if an orphan slot is reserved', async () => {
  const store = new MemoryBlobStore();
  const first = rawSubmission({ deviceId: DEVICE_A, submissionId: SUB_A1 });
  const second = rawSubmission({ deviceId: DEVICE_B, submissionId: SUB_B1 });
  const third = rawSubmission({ deviceId: DEVICE_C, submissionId: SUB_C1 });

  await reviewExactPriceCandidate({ store, candidate: candidate(first, NOW + 1), now: NOW + 1 });
  const results = await Promise.all([
    reviewExactPriceCandidate({ store, candidate: candidate(second, NOW + 2), now: NOW + 2 }),
    reviewExactPriceCandidate({ store, candidate: candidate(third, NOW + 3), now: NOW + 3 }),
  ]);

  assert.equal(results.every(result => result.status === 'auto_approved'), true);
  const events = await listValidPublicEvents({ store, libraryId: first.libraryId });
  assert.equal(events.length, 1);
  assert.equal(events[0].version, 1);
  assert.equal(countPrefix(store, `public/${first.libraryId}/approvals/`), 1);

  const snapshot = await buildPublicSnapshot({
    store,
    groupId: first.groupId,
    libraryId: first.libraryId,
    now: NOW + 10,
  });
  assert.equal(snapshot.publicVersion, 1);
  assert.equal(snapshot.records.length, 1);
});

test('independent trusted approvals reserve increasing versions and rebuild a two-record snapshot', async () => {
  const store = new MemoryBlobStore();
  await trust(store, DEVICE_A);
  const first = rawSubmission({ deviceId: DEVICE_A, submissionId: SUB_A1, serviceName: '测试服务A', unitPrice: 110 });
  const second = rawSubmission({ deviceId: DEVICE_A, submissionId: SUB_A2, serviceName: '测试服务B', unitPrice: 80 });

  const approved1 = await reviewExactPriceCandidate({ store, candidate: candidate(first, NOW + 1), now: NOW + 1 });
  const approved2 = await reviewExactPriceCandidate({ store, candidate: candidate(second, NOW + 2), now: NOW + 2 });
  assert.equal(approved1.eventVersion, 1);
  assert.equal(approved2.eventVersion, 2);

  const events = await listValidPublicEvents({ store, libraryId: first.libraryId });
  assert.deepEqual(events.map(event => event.version), [1, 2]);
  const snapshot = await buildPublicSnapshot({
    store,
    groupId: first.groupId,
    libraryId: first.libraryId,
    now: NOW + 3,
  });
  assert.equal(snapshot.publicVersion, 2);
  assert.equal(snapshot.records.length, 2);
  assert.deepEqual(snapshot.records.map(record => record.payload.serviceName).sort(), ['测试服务A', '测试服务B']);
});

test('event storage failure cannot create an approval index or snapshot and a replay can recover', async () => {
  const store = new MemoryBlobStore();
  await trust(store, DEVICE_A);
  const raw = rawSubmission({ deviceId: DEVICE_A, submissionId: SUB_A1 });
  store.failNextSet(`public/${raw.libraryId}/events/`);

  await assert.rejects(
    reviewExactPriceCandidate({ store, candidate: candidate(raw, NOW + 1), now: NOW + 1 }),
    error => error?.code === 'BLOB_ONLY_IF_NEW_FAILED',
  );
  assert.equal(countPrefix(store, `public/${raw.libraryId}/approvals/`), 0);
  assert.equal(countPrefix(store, `public/${raw.libraryId}/snapshots/`), 0);
  assert.equal((await listValidPublicEvents({ store, libraryId: raw.libraryId })).length, 0);

  const recovered = await reviewExactPriceCandidate({ store, candidate: candidate(raw, NOW + 2), now: NOW + 2 });
  assert.equal(recovered.status, 'auto_approved');
  assert.equal(recovered.eventVersion, 1);
  assert.equal(recovered.publicVersion, 1);
});

test('snapshot storage failure leaves a valid event and replay regenerates the missing snapshot', async () => {
  const store = new MemoryBlobStore();
  await trust(store, DEVICE_A);
  const raw = rawSubmission({ deviceId: DEVICE_A, submissionId: SUB_A1 });
  store.failNextSet(`public/${raw.libraryId}/snapshots/`);

  await assert.rejects(
    reviewExactPriceCandidate({ store, candidate: candidate(raw, NOW + 1), now: NOW + 1 }),
    error => error?.code === 'BLOB_ONLY_IF_NEW_FAILED',
  );
  assert.equal((await listValidPublicEvents({ store, libraryId: raw.libraryId })).length, 1);
  assert.equal(countPrefix(store, `public/${raw.libraryId}/approvals/`), 1);
  assert.equal(countPrefix(store, `public/${raw.libraryId}/snapshots/`), 0);

  const recovered = await reviewExactPriceCandidate({ store, candidate: candidate(raw, NOW + 2), now: NOW + 2 });
  assert.equal(recovered.status, 'auto_approved');
  assert.equal(recovered.duplicateApproval, true);
  assert.equal(recovered.publicMutationApplied, false);
  assert.equal(countPrefix(store, `public/${raw.libraryId}/snapshots/`), 1);
});
