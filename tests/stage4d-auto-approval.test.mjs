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
const DEVICE_D = 'dev_01JABCDEF0123456789XYZABCG';
const DEVICE_E = 'dev_01JABCDEF0123456789XYZABCH';
const SUB_A1 = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_A2 = 'sub_01JABCDEF0123456789XYZABCE';
const SUB_B1 = 'sub_01JABCDEF0123456789XYZABCF';
const SUB_C1 = 'sub_01JABCDEF0123456789XYZABCG';
const SUB_D1 = 'sub_01JABCDEF0123456789XYZABCH';
const SUB_E1 = 'sub_01JABCDEF0123456789XYZABCJ';
const NOW = 1784403000000;

function submission({
  deviceId = DEVICE_A,
  submissionId = SUB_A1,
  serviceName = '测试服务A',
  settleType = 'round',
  unitPrice = 100,
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

async function trust(store, deviceId) {
  await store.setJSON(trustedDeviceKey(deviceId), {
    schemaVersion: 1,
    deviceId,
    trusted: true,
    trustedAt: NOW,
    revokedAt: null,
  });
}

function valuesWithPrefix(store, prefix) {
  return [...store.values.entries()].filter(([key]) => key.startsWith(prefix));
}

async function approveInitial(store, unitPrice = 100) {
  await trust(store, DEVICE_C);
  const raw = submission({ deviceId: DEVICE_C, submissionId: SUB_C1, unitPrice });
  const result = await reviewExactPriceCandidate({ store, candidate: candidate(raw), now: NOW + 10 });
  assert.equal(result.status, 'auto_approved');
  assert.equal(result.eventVersion, 1);
  return raw;
}

test('first normal device waits in baseline cycle zero and does not mutate public data', async () => {
  const store = new MemoryBlobStore();
  const raw = submission();
  const result = await reviewExactPriceCandidate({ store, candidate: candidate(raw), now: NOW + 10 });

  assert.equal(result.status, 'waiting_confirmation');
  assert.equal(result.reason, 'second_device_required');
  assert.equal(result.baselineApprovedVersion, 0);
  assert.equal(result.matchingDistinctDeviceCount, 1);
  assert.equal(result.publicVersion, 0);
  assert.equal(result.publicMutationApplied, false);
  assert.equal(valuesWithPrefix(store, 'public/').length, 0);
  assert.equal(valuesWithPrefix(store, confirmationPrefix(raw.libraryId, raw.businessKey, 0)).length, 1);
  assert.ok(store.lists.every(item => item.consistency === 'strong'));
});

test('two distinct devices with identical new content auto-approve exactly one event', async () => {
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
  assert.equal(events[0].baseline.approvedVersion, 0);

  const replay = await reviewExactPriceCandidate({ store, candidate: candidate(first), now: NOW + 30 });
  assert.equal(replay.status, 'auto_approved');
  assert.equal(replay.decision, 'duplicate_noop');
  assert.equal(replay.publicMutationApplied, false);
  assert.equal((await listValidPublicEvents({ store, libraryId: first.libraryId })).length, 1);
});

test('multiple submissions from the same device still count as one confirmation', async () => {
  const store = new MemoryBlobStore();
  const first = submission({ deviceId: DEVICE_A, submissionId: SUB_A1 });
  const repeat = submission({ deviceId: DEVICE_A, submissionId: SUB_A2 });

  await reviewExactPriceCandidate({ store, candidate: candidate(first), now: NOW + 10 });
  const result = await reviewExactPriceCandidate({ store, candidate: candidate(repeat, NOW + 20), now: NOW + 20 });

  assert.equal(result.status, 'waiting_confirmation');
  assert.equal(result.matchingDistinctDeviceCount, 1);
  assert.equal((await listValidPublicEvents({ store, libraryId: first.libraryId })).length, 0);
  assert.equal(valuesWithPrefix(store, confirmationPrefix(first.libraryId, first.businessKey, 0)).length, 1);
});

test('trusted device approves a new ordinary price once', async () => {
  const store = new MemoryBlobStore();
  await trust(store, DEVICE_C);
  const raw = submission({ deviceId: DEVICE_C, submissionId: SUB_C1 });
  const result = await reviewExactPriceCandidate({ store, candidate: candidate(raw), now: NOW + 10 });

  assert.equal(result.status, 'auto_approved');
  assert.equal(result.approvalMode, 'trusted_device');
  assert.equal(result.matchingDistinctDeviceCount, 1);
  assert.equal(result.publicVersion, 1);
  const [event] = await listValidPublicEvents({ store, libraryId: raw.libraryId });
  assert.deepEqual(event.approval.deviceIds, [DEVICE_C]);
});

test('different new values in the same baseline cycle enter review and never publish', async () => {
  const store = new MemoryBlobStore();
  const value100 = submission({ deviceId: DEVICE_A, submissionId: SUB_A1, unitPrice: 100 });
  const value105 = submission({ deviceId: DEVICE_B, submissionId: SUB_B1, unitPrice: 105 });

  await reviewExactPriceCandidate({ store, candidate: candidate(value100), now: NOW + 10 });
  const conflict = await reviewExactPriceCandidate({ store, candidate: candidate(value105, NOW + 20), now: NOW + 20 });

  assert.equal(conflict.status, 'pending_review');
  assert.equal(conflict.reason, 'candidate_conflict');
  assert.equal(conflict.conflictingCandidateCount, 1);
  assert.equal((await listValidPublicEvents({ store, libraryId: value100.libraryId })).length, 0);
  const reviewPrefix = `reviews/${value100.libraryId}/pending/${value100.businessKey}/pv_000000000000/`;
  assert.equal(valuesWithPrefix(store, reviewPrefix).length, 2);
});

test('content already equal to public data is a no-op and does not pollute the next confirmation cycle', async () => {
  const store = new MemoryBlobStore();
  const publicValue = await approveInitial(store, 100);
  const same = submission({ deviceId: DEVICE_A, submissionId: SUB_A1, unitPrice: 100 });
  const result = await reviewExactPriceCandidate({ store, candidate: candidate(same, NOW + 20), now: NOW + 20 });

  assert.equal(result.status, 'auto_approved');
  assert.equal(result.decision, 'duplicate_noop');
  assert.equal(result.approvalMode, 'public_duplicate');
  assert.equal(result.eventVersion, 1);
  assert.equal(result.publicMutationApplied, false);
  assert.equal(valuesWithPrefix(store, confirmationPrefix(publicValue.libraryId, publicValue.businessKey, 1)).length, 0);
});

test('a safe existing-price update waits for a second device even when the first device is trusted', async () => {
  const store = new MemoryBlobStore();
  const publicValue = await approveInitial(store, 100);
  await trust(store, DEVICE_A);
  const changed = submission({ deviceId: DEVICE_A, submissionId: SUB_A1, unitPrice: 105 });
  const result = await reviewExactPriceCandidate({ store, candidate: candidate(changed, NOW + 20), now: NOW + 20 });

  assert.equal(changed.businessKey, publicValue.businessKey);
  assert.equal(result.status, 'waiting_confirmation');
  assert.equal(result.reason, 'second_device_required_for_update');
  assert.equal(result.baselineApprovedVersion, 1);
  assert.equal(result.changeRatio, 0.05);
  assert.equal(result.publicVersion, 1);
});

test('two devices can auto-approve an existing-price update within plus or minus ten percent', async () => {
  const store = new MemoryBlobStore();
  const publicValue = await approveInitial(store, 100);
  const first = submission({ deviceId: DEVICE_A, submissionId: SUB_A1, unitPrice: 105 });
  const second = submission({ deviceId: DEVICE_B, submissionId: SUB_B1, unitPrice: 105 });

  await reviewExactPriceCandidate({ store, candidate: candidate(first, NOW + 20), now: NOW + 20 });
  const approved = await reviewExactPriceCandidate({ store, candidate: candidate(second, NOW + 30), now: NOW + 30 });

  assert.equal(first.businessKey, publicValue.businessKey);
  assert.equal(approved.status, 'auto_approved');
  assert.equal(approved.reason, 'two_devices_safe_price_update');
  assert.equal(approved.approvalMode, 'two_devices_safe_price_update');
  assert.equal(approved.baselineApprovedVersion, 1);
  assert.equal(approved.changeRatio, 0.05);
  assert.equal(approved.eventVersion, 2);
  assert.equal(approved.publicVersion, 2);

  const snapshot = await buildPublicSnapshot({
    store,
    groupId: first.groupId,
    libraryId: first.libraryId,
    now: NOW + 40,
  });
  assert.equal(snapshot.records[0].payload.unitPrice, 105);
  assert.equal(snapshot.records[0].approvedVersion, 2);
});

test('an exactly ten-percent update is eligible but a larger update enters review', async () => {
  const exactStore = new MemoryBlobStore();
  await approveInitial(exactStore, 100);
  const exactA = submission({ deviceId: DEVICE_A, submissionId: SUB_A1, unitPrice: 110 });
  const exactB = submission({ deviceId: DEVICE_B, submissionId: SUB_B1, unitPrice: 110 });
  await reviewExactPriceCandidate({ store: exactStore, candidate: candidate(exactA, NOW + 20), now: NOW + 20 });
  const exact = await reviewExactPriceCandidate({ store: exactStore, candidate: candidate(exactB, NOW + 30), now: NOW + 30 });
  assert.equal(exact.status, 'auto_approved');
  assert.equal(exact.changeRatio, 0.1);

  const largeStore = new MemoryBlobStore();
  await approveInitial(largeStore, 100);
  const large = submission({ deviceId: DEVICE_A, submissionId: SUB_A1, unitPrice: 111 });
  const review = await reviewExactPriceCandidate({ store: largeStore, candidate: candidate(large, NOW + 20), now: NOW + 20 });
  assert.equal(review.status, 'pending_review');
  assert.equal(review.reason, 'price_change_exceeds_limit');
  assert.ok(review.changeRatio > 0.10);
  assert.equal((await listValidPublicEvents({ store: largeStore, libraryId: large.libraryId })).length, 1);
});

test('confirmation markers from prior public versions do not block later safe updates', async () => {
  const store = new MemoryBlobStore();
  const initial = await approveInitial(store, 100);
  assert.equal(valuesWithPrefix(store, confirmationPrefix(initial.libraryId, initial.businessKey, 0)).length, 1);

  const updateA = submission({ deviceId: DEVICE_A, submissionId: SUB_A1, unitPrice: 105 });
  const updateB = submission({ deviceId: DEVICE_B, submissionId: SUB_B1, unitPrice: 105 });
  await reviewExactPriceCandidate({ store, candidate: candidate(updateA, NOW + 20), now: NOW + 20 });
  await reviewExactPriceCandidate({ store, candidate: candidate(updateB, NOW + 30), now: NOW + 30 });

  const next = submission({ deviceId: DEVICE_D, submissionId: SUB_D1, unitPrice: 108 });
  const result = await reviewExactPriceCandidate({ store, candidate: candidate(next, NOW + 40), now: NOW + 40 });
  assert.equal(result.status, 'waiting_confirmation');
  assert.equal(result.reason, 'second_device_required_for_update');
  assert.equal(result.conflictingCandidateCount, 0);
  assert.equal(result.baselineApprovedVersion, 2);
});

test('reverting to a previously approved price creates a new immutable event', async () => {
  const store = new MemoryBlobStore();
  await approveInitial(store, 100);

  const upA = submission({ deviceId: DEVICE_A, submissionId: SUB_A1, unitPrice: 105 });
  const upB = submission({ deviceId: DEVICE_B, submissionId: SUB_B1, unitPrice: 105 });
  await reviewExactPriceCandidate({ store, candidate: candidate(upA, NOW + 20), now: NOW + 20 });
  await reviewExactPriceCandidate({ store, candidate: candidate(upB, NOW + 30), now: NOW + 30 });

  const backD = submission({ deviceId: DEVICE_D, submissionId: SUB_D1, unitPrice: 100 });
  const backE = submission({ deviceId: DEVICE_E, submissionId: SUB_E1, unitPrice: 100 });
  await reviewExactPriceCandidate({ store, candidate: candidate(backD, NOW + 40), now: NOW + 40 });
  const reverted = await reviewExactPriceCandidate({ store, candidate: candidate(backE, NOW + 50), now: NOW + 50 });

  assert.equal(reverted.status, 'auto_approved');
  assert.equal(reverted.eventVersion, 3);
  assert.equal(reverted.publicVersion, 3);
  const events = await listValidPublicEvents({ store, libraryId: backD.libraryId });
  assert.deepEqual(events.map(event => event.payload.unitPrice), [100, 105, 100]);
});

test('orphan event slots are ignored until a complete immutable approval index points to them', async () => {
  const store = new MemoryBlobStore();
  const raw = submission();
  const approvalId = approvalIdFor(raw, null);
  const key = publicEventKey(raw.libraryId, 1);
  const event = {
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
    baseline: { approvedVersion: 0, contentHash: null, unitPrice: null },
    approval: { mode: 'two_devices_match', deviceIds: [DEVICE_A, DEVICE_B], submissionIds: [SUB_A1, SUB_B1] },
  };
  await store.setJSON(key, event);

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
    baselineApprovedVersion: 0,
    baselineContentHash: null,
    version: 1,
    eventKey: key,
    createdAt: NOW,
  });

  snapshot = await buildPublicSnapshot({ store, groupId: raw.groupId, libraryId: raw.libraryId, now: NOW + 1 });
  assert.equal(snapshot.publicVersion, 1);
  assert.equal(snapshot.records.length, 1);
});
