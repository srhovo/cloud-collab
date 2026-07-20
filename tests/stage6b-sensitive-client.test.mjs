import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import {
  computeSensitiveSubmissionHashes,
  normalizeSensitiveSubmission,
} from '../src/server/sensitive_rules_policy_v1.js';

const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const DEVICE = 'dev_01JABCDEF0123456789XYZABCD';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_B = 'sub_01JABCDEF0123456789XYZABCE';
const NOW = 1_784_620_000_000;

function loadModules() {
  const context = {
    Buffer, TextEncoder, Uint8Array, Uint32Array, DataView, URL, AbortController,
    setTimeout, clearTimeout, crypto: webcrypto,
    fetch: async () => { throw new Error('network disabled'); },
  };
  context.globalThis = context;
  for (const path of [
    'src/cloud_collab_snapshot_sync.js',
    'src/cloud_collab_submission_client.js',
    'src/cloud_collab_ordinary_types_client.js',
    'src/cloud_collab_sensitive_rules_client.js',
  ]) vm.runInNewContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
  return context;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

class MemoryQueueStore {
  constructor(records) {
    this.records = records.map(submission => ({ submission, deliveryState: 'queued', nextRetryAt: NOW }));
  }
  getDue() { return this.records.filter(item => item.deliveryState === 'queued'); }
  list() { return this.records; }
  markSending(id) { this.records.find(item => item.submission.submissionId === id).deliveryState = 'sending'; }
  markAcknowledged(id) { this.records.find(item => item.submission.submissionId === id).deliveryState = 'acknowledged'; }
  markBlocked(id, code) { const item = this.records.find(entry => entry.submission.submissionId === id); item.deliveryState = 'blocked'; item.lastErrorCode = code; }
  markRetry(id, code) { const item = this.records.find(entry => entry.submission.submissionId === id); item.deliveryState = 'retry_wait'; item.lastErrorCode = code; }
  pruneAcknowledged() {}
}

function rangePayload() {
  return {
    rangeLabel: '0-20星', alias: '王者低星', rankType: 'star', minStar: 0, maxStar: 20, namedRanks: [],
    prices: { normal: { round: 12, hour: null }, carry: { round: 18, hour: 66 }, starGuarantee: { round: null, hour: 88 } },
  };
}

test('Stage6B browser rule upserts are byte-compatible with server hashes', async () => {
  const client = loadModules().CloudCollabSensitiveRules;
  const cases = [
    ['rank_range_rule', rangePayload()],
    ['surcharge_rule', { name: '甜蜜单', keywords: ['甜蜜单', '甜蜜'], prices: { round: 5, hour: 20 }, enabled: true }],
    ['gift_rule', { serviceName: '红包', mode: 'fixed', unitPrice: 66.6 }],
  ];
  let index = 0;
  for (const [dataType, payload] of cases) {
    const submission = await client.buildSensitiveSubmission({
      deviceId: DEVICE,
      submissionId: [SUB_A, SUB_B, 'sub_01JABCDEF0123456789XYZABCF'][index++],
      groupId: GROUP,
      libraryId: LIBRARY,
      dataType,
      payload,
      clientCreatedAt: NOW,
    });
    const server = computeSensitiveSubmissionHashes(plain(submission));
    assert.equal(submission.businessKey, server.businessKey);
    assert.equal(submission.contentHash, server.contentHash);
    assert.equal(submission.idempotencyKey, server.idempotencyKey);
    assert.deepEqual(plain(normalizeSensitiveSubmission(plain(submission))), plain(submission));
  }
});

test('Stage6B browser explicit delete binds public business key and null payload', async () => {
  const client = loadModules().CloudCollabSensitiveRules;
  const businessKey = `bk_v1_${'D'.repeat(43)}`;
  const submission = await client.buildSensitiveSubmission({
    deviceId: DEVICE,
    submissionId: SUB_A,
    groupId: GROUP,
    libraryId: LIBRARY,
    dataType: 'exact_price',
    operation: 'delete',
    payload: null,
    businessKey,
    clientCreatedAt: NOW,
  });
  assert.equal(submission.businessKey, businessKey);
  assert.equal(submission.payload, null);
  assert.equal(submission.operation, 'delete');
  const server = computeSensitiveSubmissionHashes(plain(submission));
  assert.equal(server.contentHash, submission.contentHash);

  await assert.rejects(
    () => client.buildSensitiveSubmission({
      deviceId: DEVICE, submissionId: SUB_B, groupId: GROUP, libraryId: LIBRARY,
      dataType: 'exact_price', operation: 'delete', payload: {}, businessKey,
    }),
    error => error?.code === 'DELETE_PAYLOAD_MUST_BE_NULL',
  );
});

test('Stage6B boss sensitive submissions reuse the frozen Stage5G identity and hashes', async () => {
  const context = loadModules();
  const submission = await context.CloudCollabSensitiveRules.buildSensitiveSubmission({
    deviceId: DEVICE,
    submissionId: SUB_A,
    groupId: GROUP,
    libraryId: LIBRARY,
    dataType: 'boss_profile',
    payload: { bossName: '老板甲', paiDan: '直属B', discount: 0.98 },
    clientCreatedAt: NOW,
  });
  assert.match(submission.bossId, /^boss_v1_[A-Za-z0-9_-]{43}$/);
  const server = computeSensitiveSubmissionHashes(plain(submission));
  assert.equal(server.businessKey, submission.businessKey);
  assert.equal(server.contentHash, submission.contentHash);
});

test('Stage6B browser client rejects implicit origins, contacts, private fields and invalid gift modes', async () => {
  const client = loadModules().CloudCollabSensitiveRules;
  for (const origin of ['import', 'migration', 'cloudPull', 'rollback', 'system']) {
    await assert.rejects(
      () => client.buildSensitiveSubmission({
        deviceId: DEVICE, submissionId: SUB_A, groupId: GROUP, libraryId: LIBRARY,
        dataType: 'gift_rule', payload: { serviceName: '红包', mode: 'fixed', unitPrice: 10 }, origin,
      }),
      error => error?.code === 'INVALID_SUBMISSION_ORIGIN',
    );
  }
  await assert.rejects(
    () => client.buildSensitiveSubmission({
      deviceId: DEVICE, submissionId: SUB_A, groupId: GROUP, libraryId: LIBRARY,
      dataType: 'surcharge_rule', payload: { name: '微信:abcdef', keywords: ['甜蜜'], prices: { round: 5, hour: null }, enabled: true },
    }),
    error => error?.code === 'SENSITIVE_CONTACT_INFO_FORBIDDEN',
  );
  await assert.rejects(
    () => client.buildSensitiveSubmission({
      deviceId: DEVICE, submissionId: SUB_A, groupId: GROUP, libraryId: LIBRARY,
      dataType: 'gift_rule', payload: { serviceName: '红包', mode: 'variable', unitPrice: 10 },
    }),
    error => error?.code === 'VARIABLE_GIFT_PRICE_MUST_BE_NULL',
  );
});

test('Stage6B sensitive API client uses the isolated endpoint and dispatcher sends only sensitive records', async () => {
  const context = loadModules();
  const client = context.CloudCollabSensitiveRules;
  const sensitive = await client.buildSensitiveSubmission({
    deviceId: DEVICE, submissionId: SUB_A, groupId: GROUP, libraryId: LIBRARY,
    dataType: 'gift_rule', payload: { serviceName: '红包', mode: 'fixed', unitPrice: 10 }, clientCreatedAt: NOW,
  });
  const ordinary = { ...plain(sensitive), submissionId: SUB_B, dataType: 'playable_name', operation: 'upsert' };
  const paths = [];
  const api = new client.SensitiveSubmissionApiClient({
    baseClient: {
      isConfigured: () => true,
      hasWriteAccess: () => true,
      registerDevice: async () => ({ deviceId: DEVICE, deviceToken: 'token', issuedAt: NOW, expiresAt: NOW + 100000, tokenVersion: 1 }),
      request: async (path, { body }) => { paths.push([path, body.dataType]); return { publicMutationAllowed: false, autoApprovalEnabled: false }; },
    },
  });
  const queueStore = new MemoryQueueStore([plain(sensitive), ordinary]);
  const dispatcher = new client.SensitiveSubmissionDispatcher({
    apiClient: api,
    metaStore: { loadResult: () => ({ ok: true, exists: true, value: { deviceId: DEVICE, nickname: null } }) },
    credentialStore: { getValid: () => ({ deviceId: DEVICE, deviceToken: 'token', expiresAt: NOW + 100000 }), save: value => value },
    queueStore,
    bindingStore: { list: () => [{ mode: 'collaborate', groupId: GROUP, libraryId: LIBRARY }] },
    now: () => NOW,
  });
  const result = await dispatcher.flush({ limit: 10 });
  assert.deepEqual(paths, [['/api/preview/sensitive-submissions/create', 'gift_rule']]);
  assert.equal(result.acknowledged, 1);
  assert.equal(queueStore.records.find(item => item.submission.dataType === 'playable_name').deliveryState, 'queued');
});
