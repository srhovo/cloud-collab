import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalIdFor,
  approvalIndexKey,
  buildPublicSnapshot,
  confirmationPrefix,
  listValidPublicEvents,
  publicEventKey,
  reviewExactPriceCandidate,
  trustedDeviceKey,
} from '../src/server/auto_approval_v1.js';
import {
  buildIdempotencyKey,
  computeSubmissionHashes,
} from '../src/server/submission_policy_v1.js';

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.reads = [];
    this.writes = [];
    this.lists = [];
  }

  clone(value) {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  async get(key, options = {}) {
    this.reads.push({ key, options: this.clone(options) });
    return this.values.has(key) ? this.clone(this.values.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    this.writes.push({ key, options: this.clone(options) });
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
const NOW = 1784403000000;

function submission({
  deviceId = DEVICE_A,
  submissionId = SUB_A1,
  serviceName = '测试服务A',
  settleType = 'round',
  unitPrice = 110,
} = {}) {
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
    payload: { serviceName, settleType, unitPrice },
    clientContext: { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  const computed = computeSubmissionHashes(value);
  value.businessKey = computed.businessKey;
  value.contentHash = computed.contentHash;
  value.idempotencyKey = computed.idempotencyKey;
  return value;
}

function candidate(rawSubmission, receivedAt = NOW + 1) {
  return {
    schemaVersion: 1,
    requestHash: 'req_v1_0000000000000000000000000000000000000000000',
    status: 'waiting_confirmation',
    decision: 'waiting_confirmation',
    reason: 'second_device_required',
    submission: rawSubmission,
    receivedAt,
    authenticatedTokenVersion: 1,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
  };
}

function valuesWithPrefix(store, prefix) {
  return [...store.values.entries()].filter(([key]) => key.startsWith(prefix));
}

test('first normal device remains waiting and does not create a public event', async () => {
  const store = new MemoryBlobStore();
  const raw = submission();
  const result = await reviewExactPriceCandidate({ store, candidate: candidate(raw), now: NOW + 10 });

  assert.equal(result.status, 'waiting_confirmation');
  assert.equal(result.decision, 'waiting_confirmation');
  assert.equal(result.matchingDistinctDeviceCount, 1);
  assert.equal(result.publicVersion, 0);
  assert.equal(result.publicMutationApplied, false);
  assert.equal(valuesWithPrefix(store, 'public/').length, 0);
  assert.equal(valuesWithPrefix(store, confirmationPrefix(raw.libraryId, raw.businessKey)).length, 1);
  assert.ok(store.lists.every(item => item.consistency === 'strong'));
});

test('two distinct devices with identical normalized content auto-approve exactly one event', async () => {
  const store = new MemoryBlobStore();
  const first = submission({ deviceId: DEVICE_A, submissionId: SUB_A1 });
  const second = submission({ deviceId: DEVICE_B, submissionId: SUB_B1 });

  const waiting = await reviewExactPriceCandidate({ store, candidate: candidate(first), now: NOW + 10 });
  const approved = await reviewExactPriceCandidate({ store, candidate: candidate(second, NOW + 20), now: NOW + 20 });

  assert.equal(waiting.status, 'waiting_confirmation');
  assert.equal(approved.status, 'auto_approved');
  assert.equal(approved.approvalMode, 'two_devices_match');
  assert.equal(approved.matchingDistinctDeviceCount, 2);
  assert.equal(approved.eventVersion, 1);
  assert.equal(approved.publicVersion, 1);
  assert.equal(approved.publicMutationApplied, true);

  const events = await listValidPublicEvents({ store, libraryId: first.libraryId });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].approval.deviceIds, [DEVICE_A, DEVICE_B]);
  assert.equal(events[0].payload.unitPrice, 110);

  const snapshot = await buildPublicSnapshot({
    store,
    groupId: first.groupId,
    libraryId: first.libraryId,
    now: NOW + 30,
  });
  assert.equal(snapshot.publicVersion, 1);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].approvedVersion, 1);
  assert.equal(snapshot.records[0].payload.unitPrice, 110);

  const replay = await reviewExactPriceCandidate({ store, candidate: candidate(first), now: NOW + 40 });
  assert.equal(replay.status, 'auto_approved');
  assert.equal(replay.eventVersion, 1);
  assert.equal(replay.publicMutationApplied, false);
  assert.equal((await listValidPublicEvents({ store, libraryId: first.libraryId })).length, 1);
});

test('multiple submissions from the same device count as one confirmation', async () => {
  const store = new MemoryBlobStore();
  const first = submission({ deviceId: DEVICE_A, submissionId: SUB_A1 });
  const repeat = submission({ deviceId: DEVICE_A, submissionId: SUB_A2 });

  await reviewExactPriceCandidate({ store, candidate: candidate(first), now: NOW + 10 });
  const result = await reviewExactPriceCandidate({ store, candidate: candidate(repeat, NOW + 20), now: NOW + 20 });

  assert.equal(result.status, 'waiting_confirmation');
  assert.equal(result.matchingDistinctDeviceCount, 1);
  assert.equal((await listValidPublicEvents({ store, libraryId: first.libraryId })).length, 0);
  assert.equal(valuesWithPrefix(store, confirmationPrefix(first.libraryId, first.businessKey)).length, 1);
});

test('a trusted device can auto-approve once without a second device', async () => {
  const store = new MemoryBlobStore();
  const raw = submission({ deviceId: DEVICE_C, submissionId: SUB_C1 });
  await store.setJSON(trustedDeviceKey(DEVICE_C), {
    schemaVersion: 1,
    deviceId: DEVICE_C,
    trusted: true,
    trustedAt: NOW,
    revokedAt: null,
  });

  const result = await reviewExactPriceCandidate({ store, candidate: candidate(raw), now: NOW + 10 });
  assert.equal(result.status, 'auto_approved');
  assert.equal(result.approvalMode, 'trusted_device');
  assert.equal(result.matchingDistinctDeviceCount, 1);
  assert.equal(result.publicVersion, 1);

  const [event] = await listValidPublicEvents({ store, libraryId: raw.libraryId });
  assert.deepEqual(event.approval.deviceIds, [DEVICE_C]);
});

test('different values for the same business key enter review and never mutate public data', async () => {
  const store = new MemoryBlobStore();
  const value110 = submission({ deviceId: DEVICE_A, submissionId: SUB_A1, unitPrice: 110 });
  const value120 = submission({ deviceId: DEVICE_B, submissionId: SUB_B1, unitPrice: 120 });
  assert.equal(value110.businessKey, value120.businessKey);
  assert.notEqual(value110.contentHash, value120.contentHash);

  await reviewExactPriceCandidate({ store, candidate: candidate(value110), now: NOW + 10 });
  const conflict = await reviewExactPriceCandidate({ store, candidate: candidate(value120, NOW + 20), now: NOW + 20 });

  assert.equal(conflict.status, 'pending_review');
  assert.equal(conflict.reason, 'candidate_conflict');
  assert.equal(conflict.conflictingCandidateCount, 1);
  assert.equal(conflict.publicMutationApplied, false);
  assert.equal((await listValidPublicEvents({ store, libraryId: value110.libraryId })).length, 0);

  const reviewEntries = valuesWithPrefix(store, `reviews/${value110.libraryId}/pending/${value110.businessKey}/`);
  assert.equal(reviewEntries.length, 2);
  assert.deepEqual(reviewEntries.map(([key]) => key).sort(), [
    `reviews/${value110.libraryId}/pending/${value110.businessKey}/${value110.contentHash}.json`,
    `reviews/${value110.libraryId}/pending/${value110.businessKey}/${value120.contentHash}.json`,
  ].sort());
});

test('a value that differs from the current public record enters review', async () => {
  const store = new MemoryBlobStore();
  const publicValue = submission({ deviceId: DEVICE_C, submissionId: SUB_C1, unitPrice: 110 });
  await store.setJSON(trustedDeviceKey(DEVICE_C), {
    schemaVersion: 1,
    deviceId: DEVICE_C,
    trusted: true,
    trustedAt: NOW,
    revokedAt: null,
  });
  await reviewExactPriceCandidate({ store, candidate: candidate(publicValue), now: NOW + 10 });

  for (const key of [...store.values.keys()]) {
    if (key.startsWith(confirmationPrefix(publicValue.libraryId, publicValue.businessKey))) {
      await store.delete(key);
    }
  }

  const changed = submission({ deviceId: DEVICE_A, submissionId: SUB_A1, unitPrice: 120 });
  const result = await reviewExactPriceCandidate({ store, candidate: candidate(changed, NOW + 20), now: NOW + 20 });
  assert.equal(result.status, 'pending_review');
  assert.equal(result.reason, 'public_value_conflict');
  assert.equal(result.publicVersion, 1);
  assert.equal((await listValidPublicEvents({ store, libraryId: changed.libraryId })).length, 1);
});

test('content already equal to public data is accepted as a no-op without a new event', async () => {
  const store = new MemoryBlobStore();
  const trusted = submission({ deviceId: DEVICE_C, submissionId: SUB_C1, unitPrice: 110 });
  await store.setJSON(trustedDeviceKey(DEVICE_C), {
    schemaVersion: 1,
    deviceId: DEVICE_C,
    trusted: true,
    trustedAt: NOW,
    revokedAt: null,
  });
  await reviewExactPriceCandidate({ store, candidate: candidate(trusted), now: NOW + 10 });

  const same = submission({ deviceId: DEVICE_A, submissionId: SUB_A1, unitPrice: 110 });
  const result = await reviewExactPriceCandidate({ store, candidate: candidate(same, NOW + 20), now: NOW + 20 });
  assert.equal(result.status, 'auto_approved');
  assert.equal(result.decision, 'duplicate_noop');
  assert.equal(result.approvalMode, 'public_duplicate');
  assert.equal(result.publicMutationApplied, false);
  assert.equal(result.eventVersion, 1);
  assert.equal((await listValidPublicEvents({ store, libraryId: same.libraryId })).length, 1);
});

test('orphan event slots are ignored unless the immutable approval index points to them', async () => {
  const store = new MemoryBlobStore();
  const raw = submission();
  const approvalId = approvalIdFor(raw);
  const key = publicEventKey(raw.libraryId, 1);
  await store.setJSON(key, {
    schemaVersion: 1,
    version: 1,
    eventKey: key,
    approvalId,
    groupId: raw.groupId,
    libraryId: raw.libraryId,
    approvedAt: new Date(NOW).toISOString(),
    businessKey: raw.businessKey,
    contentHash: raw.contentHash,
    dataType: raw.dataType,
    operation: raw.operation,
    payload: raw.payload,
    approval: { mode: 'two_devices_match', deviceIds: [DEVICE_A, DEVICE_B], submissionIds: [SUB_A1, SUB_B1] },
  });

  let snapshot = await buildPublicSnapshot({ store, groupId: raw.groupId, libraryId: raw.libraryId, now: NOW });
  assert.equal(snapshot.publicVersion, 0);
  assert.equal(snapshot.records.length, 0);

  await store.setJSON(approvalIndexKey(raw.libraryId, approvalId), {
    schemaVersion: 1,
    approvalId,
    groupId: raw.groupId,
    libraryId: raw.libraryId,
    businessKey: raw.businessKey,
    contentHash: raw.contentHash,
    version: 1,
    eventKey: key,
    createdAt: NOW,
  });
  snapshot = await buildPublicSnapshot({ store, groupId: raw.groupId, libraryId: raw.libraryId, now: NOW });
  assert.equal(snapshot.publicVersion, 1);
  assert.equal(snapshot.records.length, 1);
});
