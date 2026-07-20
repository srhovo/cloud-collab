import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import {
  computeOrdinarySubmissionHashes,
  normalizeOrdinarySubmission,
} from '../src/server/ordinary_types_policy_v1.js';

const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_B = 'sub_01JABCDEF0123456789XYZABCE';
const NOW = 1_784_540_000_000;

function loadBrowserModules() {
  const context = {
    Buffer,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    DataView,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    crypto: webcrypto,
    fetch: async () => { throw new Error('network disabled in unit test'); },
  };
  context.globalThis = context;
  for (const path of [
    'src/cloud_collab_snapshot_sync.js',
    'src/cloud_collab_submission_client.js',
    'src/cloud_collab_ordinary_types_client.js',
  ]) {
    vm.runInNewContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
  }
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function remoteRecord(submission, approvedVersion = 1) {
  return {
    approvedVersion,
    businessKey: submission.businessKey,
    contentHash: submission.contentHash,
    dataType: submission.dataType,
    operation: submission.operation,
    payload: plain(submission.payload),
  };
}

class MemoryQueueStore {
  constructor(records) {
    this.records = records.map(item => ({
      submission: item,
      deliveryState: 'queued',
      attemptCount: 0,
      nextRetryAt: NOW,
      lastErrorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    }));
  }
  getDue() { return this.records.filter(item => item.deliveryState === 'queued'); }
  list() { return this.records; }
  markSending(id) { this.records.find(item => item.submission.submissionId === id).deliveryState = 'sending'; }
  markAcknowledged(id) { this.records.find(item => item.submission.submissionId === id).deliveryState = 'acknowledged'; }
  markBlocked(id, code) { const item = this.records.find(entry => entry.submission.submissionId === id); item.deliveryState = 'blocked'; item.lastErrorCode = code; }
  markRetry(id, code) { const item = this.records.find(entry => entry.submission.submissionId === id); item.deliveryState = 'retry_wait'; item.lastErrorCode = code; }
  pruneAcknowledged() {}
}

test('Stage5G browser ordinary projections produce byte-compatible server hashes and strict payloads', async () => {
  const context = loadBrowserModules();
  const client = context.CloudCollabOrdinaryTypes;
  const playable = await client.buildOrdinarySubmission({
    deviceId: DEVICE_A,
    submissionId: SUB_A,
    groupId: GROUP,
    libraryId: LIBRARY,
    dataType: 'playable_name',
    payload: { name: ' Alice ' },
    clientCreatedAt: NOW,
  });
  assert.equal(playable.payload.name, 'Alice');
  assert.equal(playable.bossId, null);
  assert.deepEqual(plain(normalizeOrdinarySubmission(plain(playable))), plain(playable));
  const playableServer = computeOrdinarySubmissionHashes(plain(playable));
  assert.equal(playable.businessKey, playableServer.businessKey);
  assert.equal(playable.contentHash, playableServer.contentHash);
  assert.equal(playable.idempotencyKey, playableServer.idempotencyKey);

  const boss = await client.buildOrdinarySubmission({
    deviceId: DEVICE_B,
    submissionId: SUB_B,
    groupId: GROUP,
    libraryId: LIBRARY,
    dataType: 'boss_profile',
    payload: { name: '老板甲', bossName: '老板甲', paiDan: '直属A', discount: 0.97, usageCount: 999 },
    clientCreatedAt: NOW + 1,
  });
  assert.deepEqual(plain(boss.payload), { bossName: '老板甲', paiDan: '直属A', discount: 0.97 });
  assert.match(boss.bossId, /^boss_v1_[A-Za-z0-9_-]{43}$/);
  const bossServer = computeOrdinarySubmissionHashes(plain(boss));
  assert.equal(boss.businessKey, bossServer.businessKey);
  assert.equal(boss.contentHash, bossServer.contentHash);
  assert.equal(boss.idempotencyKey, bossServer.idempotencyKey);
  assert.deepEqual(plain(normalizeOrdinarySubmission(plain(boss))), plain(boss));

  await assert.rejects(
    () => client.buildOrdinarySubmission({
      deviceId: DEVICE_A,
      submissionId: SUB_B,
      groupId: GROUP,
      libraryId: LIBRARY,
      dataType: 'playable_name',
      payload: { name: '微信 wx123456' },
    }),
    error => error?.code === 'ORDINARY_CONTACT_INFO_FORBIDDEN',
  );
});

test('Stage5G initial ordinary plan projects only confirmed names and boss public fields', async () => {
  const { CloudCollabOrdinaryTypes: client } = loadBrowserModules();
  let index = 0;
  const ids = [SUB_A, SUB_B, 'sub_01JABCDEF0123456789XYZABCF'];
  const plan = await client.planInitialOrdinarySubmissions({
    deviceId: DEVICE_A,
    groupId: GROUP,
    libraryId: LIBRARY,
    confirmedNames: [
      { name: 'Alice', original: 'raw-chat-name', source: 'interactive', timestamp: 123 },
      { name: 'ALICE', original: 'duplicate', source: 'migration', timestamp: 456 },
    ],
    bossMemory: [
      { name: '老板甲', paiDan: '直属A', discount: 0.97, usageCount: 88, lastUsed: 123 },
    ],
    baseHashes: {},
    submissionIdFactory: () => ids[index++],
    now: () => NOW,
  });
  assert.equal(plan.submissions.length, 2);
  assert.equal(plan.skipped.duplicate, 1);
  const text = JSON.stringify(plan);
  for (const forbidden of ['raw-chat-name', 'interactive', 'migration', 'timestamp', 'usageCount', 'lastUsed']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(plain(plan.submissions.map(item => item.dataType).sort()), ['boss_profile', 'playable_name']);
  assert.ok(plan.submissions.every(item => item.origin === 'initialBinding'));
});

test('Stage5G ordinary three-way merge applies remote additions and protects local conflicts', async () => {
  const { CloudCollabOrdinaryTypes: client } = loadBrowserModules();
  const playable = await client.buildOrdinarySubmission({
    deviceId: DEVICE_A,
    submissionId: SUB_A,
    groupId: GROUP,
    libraryId: LIBRARY,
    dataType: 'playable_name',
    payload: { name: 'Alice' },
    clientCreatedAt: NOW,
  });
  const boss = await client.buildOrdinarySubmission({
    deviceId: DEVICE_B,
    submissionId: SUB_B,
    groupId: GROUP,
    libraryId: LIBRARY,
    dataType: 'boss_profile',
    payload: { bossName: '老板甲', paiDan: '直属A', discount: 0.97 },
    clientCreatedAt: NOW,
  });
  const plan = await client.planOrdinaryMerge({
    groupId: GROUP,
    libraryId: LIBRARY,
    records: [remoteRecord(playable, 1), remoteRecord(boss, 2)],
    confirmedNames: [],
    bossMemory: [],
    baseHashes: {},
  });
  assert.deepEqual(plain(plan.counts), { upserts: 2, unchanged: 0, preserveLocal: 0, conflicts: 0 });
  const applied = client.applyOrdinaryMergePlan({ confirmedNames: [], bossMemory: [], plan, now: NOW });
  assert.deepEqual(plain(applied.confirmedNames), [{ name: 'Alice', original: 'Alice', timestamp: NOW, source: 'cloudPull' }]);
  assert.deepEqual(plain(applied.bossMemory), [{ name: '老板甲', paiDan: '直属A', discount: 0.97 }]);

  const remoteChanged = await client.buildOrdinarySubmission({
    deviceId: DEVICE_B,
    submissionId: 'sub_01JABCDEF0123456789XYZABCF',
    groupId: GROUP,
    libraryId: LIBRARY,
    dataType: 'boss_profile',
    payload: { bossName: '老板甲', paiDan: '直属B', discount: 0.97 },
    clientCreatedAt: NOW + 1,
  });
  const conflict = await client.planOrdinaryMerge({
    groupId: GROUP,
    libraryId: LIBRARY,
    records: [remoteRecord(remoteChanged, 3)],
    confirmedNames: applied.confirmedNames,
    bossMemory: [{ name: '老板甲', paiDan: '本地直属', discount: 0.96 }],
    baseHashes: { [boss.businessKey]: boss.contentHash },
  });
  assert.equal(conflict.counts.conflicts, 1);
  assert.equal(conflict.upserts.length, 0);
  assert.equal(conflict.conflicts[0].dataType, 'boss_profile');
});

test('Stage5G ordinary dispatcher sends all three ordinary preview types and blocks sensitive types client-side', async () => {
  const context = loadBrowserModules();
  const client = context.CloudCollabOrdinaryTypes;
  const playable = await client.buildOrdinarySubmission({
    deviceId: DEVICE_A,
    submissionId: SUB_A,
    groupId: GROUP,
    libraryId: LIBRARY,
    dataType: 'playable_name',
    payload: { name: 'Alice' },
    clientCreatedAt: NOW,
  });
  const boss = await client.buildOrdinarySubmission({
    deviceId: DEVICE_A,
    submissionId: SUB_B,
    groupId: GROUP,
    libraryId: LIBRARY,
    dataType: 'boss_profile',
    payload: { bossName: '老板甲', paiDan: '直属A', discount: 0.97 },
    clientCreatedAt: NOW,
  });
  const sensitive = { ...plain(playable), submissionId: 'sub_01JABCDEF0123456789XYZABCF', dataType: 'gift_rule' };
  const queueStore = new MemoryQueueStore([plain(playable), plain(boss), sensitive]);
  const submitted = [];
  const dispatcher = new client.OrdinarySubmissionDispatcher({
    apiClient: {
      isConfigured: () => true,
      hasWriteAccess: () => true,
      submit: async (_token, submission) => { submitted.push(submission.dataType); return { publicMutationAllowed: false, autoApprovalEnabled: false }; },
    },
    metaStore: { loadResult: () => ({ ok: true, exists: true, value: { deviceId: DEVICE_A, nickname: null } }) },
    credentialStore: { getValid: () => ({ deviceId: DEVICE_A, deviceToken: 'token', expiresAt: NOW + 100000 }), prune: () => {} },
    queueStore,
    bindingStore: { list: () => [{ mode: 'collaborate', groupId: GROUP, libraryId: LIBRARY }] },
    now: () => NOW,
  });
  const result = await dispatcher.flush({ limit: 10 });
  assert.deepEqual(submitted.sort(), ['boss_profile', 'playable_name']);
  assert.equal(result.acknowledged, 2);
  assert.equal(result.blocked, 1);
  assert.equal(queueStore.records.find(item => item.submission.dataType === 'gift_rule').lastErrorCode, 'PREVIEW_SCOPE_CLIENT_BLOCKED');
});
