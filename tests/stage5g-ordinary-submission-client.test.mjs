import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { computeOrdinarySubmissionHashes } from '../src/server/ordinary_types_policy_v1.js';

const require = createRequire(import.meta.url);
const snapshotSync = require('../src/cloud_collab_snapshot_sync.js');
const baseSubmission = require('../src/cloud_collab_submission_client.js');
const ordinary = require('../src/cloud_collab_ordinary_submission_client.js');

const DEVICE = 'dev_01JABCDEF0123456789XYZABCD';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_B = 'sub_01JABCDEF0123456789XYZABCE';
const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const NOW = 1_784_550_000_000;

function serverRecompute(submission) {
  const computed = computeOrdinarySubmissionHashes(submission);
  return {
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    idempotencyKey: computed.idempotencyKey,
    bossId: computed.submission.bossId,
    payload: computed.submission.payload,
  };
}

test('Stage5G browser playable-name submission hashes exactly match the server policy', async () => {
  const submission = await ordinary.buildPlayableNameSubmission({
    snapshotSync,
    base: baseSubmission,
    deviceId: DEVICE,
    submissionId: SUB_A,
    groupId: GROUP,
    libraryId: LIBRARY,
    name: '  Ａlice  ',
    origin: 'user',
    clientCreatedAt: NOW,
  });
  assert.equal(submission.payload.name, 'Alice');
  assert.equal(submission.bossId, null);
  assert.equal(submission.dataType, 'playable_name');
  assert.deepEqual(serverRecompute(submission), {
    businessKey: submission.businessKey,
    contentHash: submission.contentHash,
    idempotencyKey: submission.idempotencyKey,
    bossId: null,
    payload: submission.payload,
  });
});

test('Stage5G browser boss submission derives the same stable boss identity and hashes as the server', async () => {
  const submission = await ordinary.buildBossProfileSubmission({
    snapshotSync,
    base: baseSubmission,
    deviceId: DEVICE,
    submissionId: SUB_B,
    groupId: GROUP,
    libraryId: LIBRARY,
    bossName: '老板甲',
    paiDan: '直属A',
    discount: 0.9700,
    origin: 'initialBinding',
    clientCreatedAt: NOW,
  });
  const recomputed = serverRecompute(submission);
  assert.equal(submission.dataType, 'boss_profile');
  assert.match(submission.bossId, /^boss_v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(recomputed.bossId, submission.bossId);
  assert.equal(recomputed.businessKey, submission.businessKey);
  assert.equal(recomputed.contentHash, submission.contentHash);
  assert.equal(recomputed.idempotencyKey, submission.idempotencyKey);
});

test('Stage5G browser ordinary builders fail closed on contact data, unsafe origins, and non-fixture scope', async () => {
  await assert.rejects(
    () => ordinary.buildPlayableNameSubmission({
      snapshotSync,
      base: baseSubmission,
      deviceId: DEVICE,
      submissionId: SUB_A,
      groupId: GROUP,
      libraryId: LIBRARY,
      name: '加我微信 abc12345',
    }),
    error => error.code === 'ORDINARY_CONTACT_INFO_FORBIDDEN',
  );
  await assert.rejects(
    () => ordinary.buildBossProfileSubmission({
      snapshotSync,
      base: baseSubmission,
      deviceId: DEVICE,
      submissionId: SUB_A,
      groupId: GROUP,
      libraryId: LIBRARY,
      bossName: '老板甲',
      paiDan: '直属A',
      discount: 0.97,
      origin: 'cloudPull',
    }),
    error => error.code === 'INVALID_SUBMISSION_ORIGIN',
  );
  await assert.rejects(
    () => ordinary.buildPlayableNameSubmission({
      snapshotSync,
      base: baseSubmission,
      deviceId: DEVICE,
      submissionId: SUB_A,
      groupId: GROUP,
      libraryId: 'lib_other',
      name: '小明',
    }),
    error => error.code === 'PREVIEW_SCOPE_CLIENT_BLOCKED',
  );
});

class QueueStore {
  constructor(submissions) {
    this.records = submissions.map(submission => ({ submission, deliveryState: 'pending', nextAttemptAt: 0 }));
  }
  getDue(_now, limit) { return this.records.filter(item => item.deliveryState === 'pending').slice(0, limit); }
  list() { return this.records; }
  markSending(id) { this.records.find(item => item.submission.submissionId === id).deliveryState = 'sending'; }
  markAcknowledged(id) { this.records.find(item => item.submission.submissionId === id).deliveryState = 'acknowledged'; }
  markBlocked(id, code) { const item = this.records.find(row => row.submission.submissionId === id); item.deliveryState = 'blocked'; item.lastErrorCode = code; }
  markRetry(id, code) { const item = this.records.find(row => row.submission.submissionId === id); item.deliveryState = 'retry_wait'; item.lastErrorCode = code; }
  pruneAcknowledged() { this.records = this.records.filter(item => item.deliveryState !== 'acknowledged'); }
}

test('Stage5G combined dispatcher sends exact, playable, and boss upserts but blocks unsupported records', async () => {
  const playable = await ordinary.buildPlayableNameSubmission({
    snapshotSync,
    base: baseSubmission,
    deviceId: DEVICE,
    submissionId: SUB_A,
    groupId: GROUP,
    libraryId: LIBRARY,
    name: '小明',
    clientCreatedAt: NOW,
  });
  const boss = await ordinary.buildBossProfileSubmission({
    snapshotSync,
    base: baseSubmission,
    deviceId: DEVICE,
    submissionId: SUB_B,
    groupId: GROUP,
    libraryId: LIBRARY,
    bossName: '老板甲',
    paiDan: '直属A',
    discount: 0.97,
    clientCreatedAt: NOW,
  });
  const unsupported = { ...playable, submissionId: 'sub_01JABCDEF0123456789XYZABCF', dataType: 'range_rule' };
  const queueStore = new QueueStore([playable, boss, unsupported]);
  const sent = [];
  const dispatcher = new ordinary.SubmissionDispatcher({
    apiClient: {
      isConfigured: () => true,
      hasWriteAccess: () => true,
      submit: async (_token, submission) => { sent.push(submission.dataType); },
    },
    metaStore: { loadResult: () => ({ ok: true, exists: true, value: { deviceId: DEVICE } }) },
    credentialStore: {
      getValid: () => ({ deviceId: DEVICE, deviceToken: 'synthetic-token' }),
      loadResult: () => ({ ok: true, exists: true }),
      clear: () => true,
    },
    queueStore,
    bindingStore: { list: () => [{ mode: 'collaborate', groupId: GROUP, libraryId: LIBRARY }] },
    now: () => NOW,
    isOnline: () => true,
  });
  const result = await dispatcher.flush({ limit: 10 });
  assert.deepEqual(sent.sort(), ['boss_profile', 'playable_name']);
  assert.equal(result.acknowledged, 2);
  assert.equal(result.blocked, 1);
  assert.equal(queueStore.records.length, 1);
  assert.equal(queueStore.records[0].lastErrorCode, 'PREVIEW_SCOPE_CLIENT_BLOCKED');
});
