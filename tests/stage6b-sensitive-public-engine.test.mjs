import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeSensitiveSubmissionHashes,
} from '../src/server/sensitive_rules_policy_v1.js';
import {
  buildUnifiedSensitivePublicSnapshot,
  listUnifiedPublicEvents,
  publishSensitiveAdminApproval,
  sensitiveApprovalIndexKey,
  sensitivePublicEventPrefix,
} from '../src/server/sensitive_public_engine_v1.js';

const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const DEVICE = 'dev_01JABCDEF0123456789XYZABCD';
const SUBMISSION = 'sub_01JABCDEF0123456789XYZABCD';
const PLACEHOLDER_BUSINESS = `bk_v1_${'A'.repeat(43)}`;
const PLACEHOLDER_CONTENT = `ch_v1_${'A'.repeat(43)}`;
const PLACEHOLDER_IDEMPOTENCY = `ik_v1_${'A'.repeat(43)}`;

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
    clientCreatedAt: 1_784_600_000_000,
    businessKey: PLACEHOLDER_BUSINESS,
    contentHash: PLACEHOLDER_CONTENT,
    idempotencyKey: PLACEHOLDER_IDEMPOTENCY,
    payload,
    clientContext: { appVersion: '8.2.31-stage6b', projectionSpecVersion: 1, queueSchemaVersion: 1 },
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

function rangePayload(price = 12) {
  return {
    rangeLabel: '0-20星',
    alias: '王者低星',
    rankType: 'star',
    minStar: 0,
    maxStar: 20,
    namedRanks: [],
    prices: {
      normal: { round: price, hour: null },
      carry: { round: 18, hour: 66 },
      starGuarantee: { round: null, hour: 88 },
    },
  };
}

function decision(seed) { return `srd_v1_${seed.repeat(43).slice(0, 43)}`; }
function review(seed) { return `srv_v1_${seed.repeat(43).slice(0, 43)}`; }

async function approve(store, submission, baseline, seed, now, edited = false) {
  return publishSensitiveAdminApproval({
    store,
    submission,
    baseline,
    reviewId: review(seed),
    decisionId: decision(seed),
    actorTag: 'admin_ABCDEFGHIJKL',
    edited,
    now,
  });
}

test('Stage6B sensitive upsert publishes immutable event and unified snapshot', async () => {
  const store = new MemoryBlobStore();
  const submission = complete(draft('rank_range_rule', rangePayload()));
  const result = await approve(store, submission, { approvedVersion: 0, contentHash: null }, 'B', 1_784_600_001_000);

  assert.equal(result.duplicate, false);
  assert.equal(result.event.operation, 'upsert');
  assert.equal(result.event.version, 1);
  assert.equal(result.snapshot.publicVersion, 1);
  assert.equal(result.snapshot.baseOrdinaryVersion, 0);
  assert.equal(result.snapshot.records.length, 1);
  assert.equal(result.snapshot.records[0].dataType, 'rank_range_rule');
  assert.equal(result.snapshot.tombstones.length, 0);
  assert.equal(result.event.approval.mode, 'admin_sensitive_approved');

  const eventKeys = [...store.values.keys()].filter(key => key.startsWith(sensitivePublicEventPrefix(LIBRARY)));
  assert.equal(eventKeys.length, 1);
  assert.equal(Boolean(await store.get(sensitiveApprovalIndexKey(LIBRARY, result.event.approvalId))), true);
});

test('Stage6B exact approval replay is idempotent and conflicting decision content fails closed', async () => {
  const store = new MemoryBlobStore();
  const first = complete(draft('gift_rule', { serviceName: '红包', mode: 'fixed', unitPrice: 66 }));
  const created = await approve(store, first, { approvedVersion: 0, contentHash: null }, 'C', 1_784_600_002_000);
  const replay = await approve(store, first, { approvedVersion: 0, contentHash: null }, 'C', 1_784_600_003_000);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.event.eventKey, created.event.eventKey);
  assert.equal([...store.values.keys()].filter(key => key.startsWith(sensitivePublicEventPrefix(LIBRARY))).length, 1);

  const changed = complete(draft('gift_rule', { serviceName: '红包', mode: 'fixed', unitPrice: 88 }, {
    submissionId: 'sub_01JABCDEF0123456789XYZABCE',
  }));
  await assert.rejects(
    () => approve(store, changed, { approvedVersion: created.event.version, contentHash: created.event.contentHash }, 'C', 1_784_600_004_000),
    error => error.code === 'SENSITIVE_APPROVAL_IDEMPOTENCY_CONFLICT' && error.status === 409,
  );
});

test('Stage6B explicit delete produces tombstone without physically deleting prior history', async () => {
  const store = new MemoryBlobStore();
  const upsert = complete(draft('surcharge_rule', {
    name: '甜蜜单', keywords: ['甜蜜单'], prices: { round: 5, hour: 20 }, enabled: true,
  }));
  const created = await approve(store, upsert, { approvedVersion: 0, contentHash: null }, 'D', 1_784_600_005_000);
  const deleteSubmission = complete(draft('surcharge_rule', null, {
    operation: 'delete',
    submissionId: 'sub_01JABCDEF0123456789XYZABCE',
    businessKey: upsert.businessKey,
  }));
  const removed = await approve(store, deleteSubmission, {
    approvedVersion: created.event.version,
    contentHash: created.event.contentHash,
  }, 'E', 1_784_600_006_000);

  assert.equal(removed.event.operation, 'delete');
  assert.equal(removed.snapshot.records.length, 0);
  assert.equal(removed.snapshot.tombstones.length, 1);
  assert.equal(removed.snapshot.tombstones[0].businessKey, upsert.businessKey);
  assert.equal(removed.snapshot.tombstones[0].operation, 'delete');
  assert.equal([...store.values.keys()].filter(key => key.startsWith(sensitivePublicEventPrefix(LIBRARY))).length, 2);

  const unified = await listUnifiedPublicEvents({ store, groupId: GROUP, libraryId: LIBRARY });
  assert.deepEqual(unified.map(event => event.operation), ['upsert', 'delete']);
});

test('Stage6B stale baselines and missing delete targets are rejected before publishing', async () => {
  const store = new MemoryBlobStore();
  const upsert = complete(draft('rank_range_rule', rangePayload()));
  const created = await approve(store, upsert, { approvedVersion: 0, contentHash: null }, 'F', 1_784_600_007_000);
  const changed = complete(draft('rank_range_rule', rangePayload(13), {
    submissionId: 'sub_01JABCDEF0123456789XYZABCE',
  }));
  await assert.rejects(
    () => approve(store, changed, { approvedVersion: 0, contentHash: null }, 'G', 1_784_600_008_000),
    error => error.code === 'SENSITIVE_REVIEW_STALE_BASELINE' && error.status === 409,
  );

  const missingDelete = complete(draft('gift_rule', null, {
    operation: 'delete',
    submissionId: 'sub_01JABCDEF0123456789XYZABCF',
    businessKey: `bk_v1_${'Z'.repeat(43)}`,
  }));
  await assert.rejects(
    () => approve(store, missingDelete, { approvedVersion: 0, contentHash: null }, 'H', 1_784_600_009_000),
    error => ['DELETE_TARGET_NOT_FOUND', 'SENSITIVE_REVIEW_STALE_BASELINE'].includes(error.code),
  );
  assert.equal((await buildUnifiedSensitivePublicSnapshot({ store, groupId: GROUP, libraryId: LIBRARY })).publicVersion, created.event.version);
});

test('Stage6B edit-and-approve mode is recorded without changing immutable source history', async () => {
  const store = new MemoryBlobStore();
  const submission = complete(draft('gift_rule', { serviceName: '随机礼物', mode: 'variable', unitPrice: null }));
  const result = await approve(store, submission, { approvedVersion: 0, contentHash: null }, 'J', 1_784_600_010_000, true);
  assert.equal(result.event.approval.mode, 'admin_sensitive_edit_and_approved');
  assert.equal(result.event.payload.mode, 'variable');
  assert.equal(result.event.payload.unitPrice, null);
});
