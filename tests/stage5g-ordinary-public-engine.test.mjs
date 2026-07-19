import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  buildPublicSnapshot,
  listValidPublicEvents,
} from '../src/server/auto_approval_engine_v1.js';
import {
  computeOrdinarySubmissionHashes,
  deriveBossId,
} from '../src/server/ordinary_types_policy_v1.js';
import {
  buildOrdinaryPublicSnapshot,
  listValidOrdinaryPublicEvents,
  reviewOrdinaryCandidate,
} from '../src/server/ordinary_public_engine_v1.js';
import { canonicalize } from '../src/server/submission_policy_v1.js';

const NOW = 1_784_520_000_000;
const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_B = 'sub_01JABCDEF0123456789XYZABCE';

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.listCalls = [];
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

  async list(options = {}) {
    this.listCalls.push(this.clone(options));
    const prefix = String(options.prefix || '');
    return {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
}

function sha(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function draft(dataType, payload, {
  deviceId = DEVICE_A,
  submissionId = SUB_A,
  bossId = null,
} = {}) {
  return {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId: GROUP,
    libraryId: LIBRARY,
    bossId,
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

function candidate(submission, receivedAt) {
  return {
    schemaVersion: 1,
    requestHash: `req_v1_${sha(canonicalize(submission))}`,
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

const neverTrusted = async () => false;
const alwaysTrusted = async () => true;

test('Stage5G exact_price events produced by the mixed engine remain readable by the frozen engine', async () => {
  const store = new MemoryBlobStore();
  const submission = complete(draft('exact_price', {
    serviceName: '鹅鸭杀',
    settleType: 'round',
    unitPrice: 88,
  }));
  const reviewed = await reviewOrdinaryCandidate({
    store,
    candidate: candidate(submission, NOW),
    now: NOW,
    trustedDeviceResolver: alwaysTrusted,
  });
  assert.equal(reviewed.status, 'auto_approved');
  assert.equal(reviewed.publicVersion, 1);

  const oldEvents = await listValidPublicEvents({ store, libraryId: LIBRARY });
  const newEvents = await listValidOrdinaryPublicEvents({ store, libraryId: LIBRARY });
  assert.deepEqual(newEvents, oldEvents);
  const oldSnapshot = await buildPublicSnapshot({ store, groupId: GROUP, libraryId: LIBRARY, now: NOW + 1 });
  const newSnapshot = await buildOrdinaryPublicSnapshot({ store, groupId: GROUP, libraryId: LIBRARY, now: NOW + 1 });
  assert.deepEqual(newSnapshot, oldSnapshot);
});

test('Stage5G two independent playable confirmations publish one event and a group-scoped snapshot record', async () => {
  const store = new MemoryBlobStore();
  const first = complete(draft('playable_name', { name: '小明' }));
  const second = complete(draft('playable_name', { name: '小明' }, {
    deviceId: DEVICE_B,
    submissionId: SUB_B,
  }));

  const waiting = await reviewOrdinaryCandidate({
    store,
    candidate: candidate(first, NOW),
    now: NOW,
    trustedDeviceResolver: neverTrusted,
  });
  assert.equal(waiting.status, 'waiting_confirmation');
  assert.equal(waiting.matchingDistinctDeviceCount, 1);

  const approved = await reviewOrdinaryCandidate({
    store,
    candidate: candidate(second, NOW + 1000),
    now: NOW + 1000,
    trustedDeviceResolver: neverTrusted,
  });
  assert.equal(approved.status, 'auto_approved');
  assert.equal(approved.approvalMode, 'two_devices_match');
  assert.equal(approved.matchingDistinctDeviceCount, 2);
  assert.equal(approved.publicVersion, 1);

  const events = await listValidOrdinaryPublicEvents({ store, libraryId: LIBRARY });
  assert.equal(events.length, 1);
  assert.equal(events[0].dataType, 'playable_name');
  assert.deepEqual(events[0].payload, { name: '小明' });
  assert.equal(events[0].baseline.unitPrice, null);

  const snapshot = await buildOrdinaryPublicSnapshot({ store, groupId: GROUP, libraryId: LIBRARY, now: NOW + 2000 });
  assert.equal(snapshot.publicVersion, 1);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].dataType, 'playable_name');
  assert.equal(snapshot.records[0].payload.name, '小明');
  assert.equal(store.listCalls.every(call => call.consistency === 'strong'), true);
});

test('Stage5G trusted device can publish a new boss and snapshot exposes the stable boss identity', async () => {
  const store = new MemoryBlobStore();
  const submission = complete(draft('boss_profile', {
    bossName: '老板甲',
    paiDan: '直属A',
    discount: 0.97,
  }));
  const approved = await reviewOrdinaryCandidate({
    store,
    candidate: candidate(submission, NOW),
    now: NOW,
    trustedDeviceResolver: alwaysTrusted,
  });
  assert.equal(approved.status, 'auto_approved');
  assert.equal(approved.approvalMode, 'trusted_device');

  const snapshot = await buildOrdinaryPublicSnapshot({ store, groupId: GROUP, libraryId: LIBRARY, now: NOW + 1000 });
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].dataType, 'boss_profile');
  assert.equal(snapshot.records[0].bossId, deriveBossId(GROUP, '老板甲'));
  assert.equal(snapshot.records[0].payload.discount, 0.97);
});

test('Stage5G same-direct-report reasonable boss discount drop requires two devices and appends a new public version', async () => {
  const store = new MemoryBlobStore();
  const initial = complete(draft('boss_profile', {
    bossName: '老板甲',
    paiDan: '直属A',
    discount: 0.97,
  }));
  await reviewOrdinaryCandidate({
    store,
    candidate: candidate(initial, NOW),
    now: NOW,
    trustedDeviceResolver: alwaysTrusted,
  });
  const bossId = deriveBossId(GROUP, '老板甲');
  const firstDrop = complete(draft('boss_profile', {
    bossName: '老板甲',
    paiDan: '直属A',
    discount: 0.95,
  }, { bossId, submissionId: 'sub_01JABCDEF0123456789XYZABCF' }));
  const secondDrop = complete(draft('boss_profile', {
    bossName: '老板甲',
    paiDan: '直属A',
    discount: 0.95,
  }, { bossId, deviceId: DEVICE_B, submissionId: 'sub_01JABCDEF0123456789XYZABCG' }));

  const waiting = await reviewOrdinaryCandidate({
    store,
    candidate: candidate(firstDrop, NOW + 2000),
    now: NOW + 2000,
    trustedDeviceResolver: neverTrusted,
  });
  assert.equal(waiting.status, 'waiting_confirmation');

  const approved = await reviewOrdinaryCandidate({
    store,
    candidate: candidate(secondDrop, NOW + 3000),
    now: NOW + 3000,
    trustedDeviceResolver: neverTrusted,
  });
  assert.equal(approved.status, 'auto_approved');
  assert.equal(approved.approvalMode, 'two_devices_ordinary_update');
  assert.equal(approved.publicVersion, 2);

  const snapshot = await buildOrdinaryPublicSnapshot({ store, groupId: GROUP, libraryId: LIBRARY, now: NOW + 4000 });
  assert.equal(snapshot.publicVersion, 2);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].payload.discount, 0.95);
});

test('Stage5G direct-report change and discount increase create review markers without public mutation', async () => {
  for (const payload of [
    { bossName: '老板甲', paiDan: '直属B', discount: 0.95 },
    { bossName: '老板甲', paiDan: '直属A', discount: 0.98 },
  ]) {
    const store = new MemoryBlobStore();
    const initial = complete(draft('boss_profile', {
      bossName: '老板甲', paiDan: '直属A', discount: 0.97,
    }));
    await reviewOrdinaryCandidate({
      store,
      candidate: candidate(initial, NOW),
      now: NOW,
      trustedDeviceResolver: alwaysTrusted,
    });
    const changed = complete(draft('boss_profile', payload, {
      bossId: deriveBossId(GROUP, '老板甲'),
      submissionId: 'sub_01JABCDEF0123456789XYZABCF',
    }));
    const reviewed = await reviewOrdinaryCandidate({
      store,
      candidate: candidate(changed, NOW + 1000),
      now: NOW + 1000,
      trustedDeviceResolver: alwaysTrusted,
    });
    assert.equal(reviewed.status, 'pending_review');
    assert.equal(reviewed.publicMutationApplied, false);
    assert.equal(reviewed.publicVersion, 1);
    assert.equal([...store.values.keys()].filter(key => key.startsWith(`reviews/${LIBRARY}/pending/`)).length >= 1, true);
  }
});
