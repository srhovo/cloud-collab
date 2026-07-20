import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildOrdinaryPublicSnapshot } from '../src/server/ordinary_public_engine_v1.js';
import { computeOrdinarySubmissionHashes } from '../src/server/ordinary_types_policy_v1.js';
import { buildIdempotencyKey } from '../src/server/submission_policy_v1.js';
import { acceptProductionOrdinarySubmission } from '../src/server/production_ordinary_types_runtime_v1.js';
import { ProductionWriteRuntimeError } from '../src/server/production_write_runtime_v1.js';
import { handleProductionSubmissionCreateRequest } from '../src/server/production_write_http_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_600_000_000;
const ACCESS_KEY = 'stage7r-production-client-access-key-0123456789';
const RATE_SALT = 'stage7r-production-rate-limit-salt-0123456789';
const DEVICES = Object.freeze([
  'dev_01JABCDEF0123456789XYZABCD',
  'dev_01JABCDEF0123456789XYZABCE',
  'dev_01JABCDEF0123456789XYZABCF',
]);
const SUBMISSIONS = Object.freeze([
  'sub_01JABCDEF0123456789XYZABCD',
  'sub_01JABCDEF0123456789XYZABCE',
  'sub_01JABCDEF0123456789XYZABCF',
  'sub_01JABCDEF0123456789XYZABCG',
]);

function env(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '0',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
    CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '0',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: '',
    CLOUD_PRODUCTION_EXTERNAL_CLUB_ID: 'see',
    CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID: 'see_cz',
    CLOUD_PRODUCTION_GROUP_ID: 'group_see',
    CLOUD_PRODUCTION_LIBRARY_ID: 'lib_see_cz',
    CLOUD_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-production-v1',
    CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-admin-production-v1',
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://app.example.invalid',
    CLOUD_ADMIN_PUBLIC_ORIGIN: '',
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: '',
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: ACCESS_KEY,
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: RATE_SALT,
    CLOUD_ADMIN_SESSION_SECRET: '',
    CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_DEVICE_REF_SALT: '',
    CLOUD_ADMIN_ROLLBACK_REF_SALT: '',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
    ...overrides,
  };
}

class MemoryStore {
  constructor() { this.items = new Map(); }
  async get(key) { return this.items.has(key) ? structuredClone(this.items.get(key)) : null; }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.items.has(key)) throw new Error('already exists');
    this.items.set(key, structuredClone(value));
  }
  async delete(key) { this.items.delete(key); }
  async list({ prefix = '' } = {}) {
    return {
      blobs: [...this.items.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function makeSubmission({ deviceId, submissionId, dataType, payload }) {
  const raw = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId: 'group_see',
    libraryId: 'lib_see_cz',
    bossId: null,
    dataType,
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: NOW,
    businessKey: `bk_v1_${'A'.repeat(43)}`,
    contentHash: `ch_v1_${'A'.repeat(43)}`,
    idempotencyKey: buildIdempotencyKey(deviceId, submissionId),
    payload,
    clientContext: { appVersion: '8.2.31', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  const hashes = computeOrdinarySubmissionHashes(raw);
  raw.businessKey = hashes.businessKey;
  raw.contentHash = hashes.contentHash;
  raw.idempotencyKey = hashes.idempotencyKey;
  if (hashes.submission?.bossId) raw.bossId = hashes.submission.bossId;
  return raw;
}

function authenticate(deviceId) {
  return async () => ({ deviceId, tokenVersion: 1 });
}

async function submit({ store, submission, runtimeEnv = env(), now = NOW }) {
  return acceptProductionOrdinarySubmission({
    store,
    authorization: 'Bearer dt_v1_stage7r',
    rawSubmission: submission,
    env: runtimeEnv,
    now,
    authenticate: authenticate(submission.deviceId),
  });
}

function post(body) {
  return new Request('https://app.example.invalid/api/submissions/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://app.example.invalid',
      Authorization: 'Bearer dt_v1_stage7r',
      'X-Cloud-Collab-Access-Key': ACCESS_KEY,
    },
    body: JSON.stringify(body),
  });
}

test('exact_price继续委托阶段7Q精确处理器而不经过新类型引擎', async () => {
  let delegated = 0;
  const expected = Object.freeze({ dataType: 'exact_price', autoApprovalEnabled: true, stablePromotionAuthorized: false });
  const result = await acceptProductionOrdinarySubmission({
    rawSubmission: { dataType: 'exact_price' },
    acceptExact: async options => {
      delegated += 1;
      assert.equal(options.acceptExact, undefined);
      return expected;
    },
  });
  assert.equal(delegated, 1);
  assert.equal(result, expected);
});

test('自动审核关闭时陪玩名字和老板资料只进入不可变候选', async () => {
  for (const submission of [
    makeSubmission({ deviceId: DEVICES[0], submissionId: SUBMISSIONS[0], dataType: 'playable_name', payload: { name: '下雪' } }),
    makeSubmission({ deviceId: DEVICES[1], submissionId: SUBMISSIONS[1], dataType: 'boss_profile', payload: { bossName: '测试老板', paiDan: '直属A', discount: 0.9 } }),
  ]) {
    const store = new MemoryStore();
    const result = await submit({ store, submission });
    assert.equal(result.dataType, submission.dataType);
    assert.equal(result.autoApprovalEnabled, false);
    assert.equal(result.autoApprovalResult, null);
    assert.equal(result.publicMutationAllowed, false);
    assert.equal(result.publicMutationApplied, false);
    assert.equal(result.stablePromotionAuthorized, false);
    const snapshot = await buildOrdinaryPublicSnapshot({ store, groupId: 'group_see', libraryId: 'lib_see_cz', now: NOW + 1 });
    assert.equal(snapshot.publicVersion, 0);
  }
});

test('两台设备提交相同陪玩名字时发布唯一公共版本', async () => {
  const store = new MemoryStore();
  const enabled = env({ CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1' });
  const first = makeSubmission({ deviceId: DEVICES[0], submissionId: SUBMISSIONS[0], dataType: 'playable_name', payload: { name: '下雪' } });
  const second = makeSubmission({ deviceId: DEVICES[1], submissionId: SUBMISSIONS[1], dataType: 'playable_name', payload: { name: '下雪' } });

  const waiting = await submit({ store, submission: first, runtimeEnv: enabled, now: NOW });
  assert.equal(waiting.autoApprovalResult.status, 'waiting_confirmation');
  assert.equal(waiting.publicMutationAllowed, true);
  assert.equal(waiting.publicMutationApplied, false);

  const approved = await submit({ store, submission: second, runtimeEnv: enabled, now: NOW + 6000 });
  assert.equal(approved.autoApprovalResult.status, 'auto_approved');
  assert.equal(approved.autoApprovalResult.approvalMode, 'two_devices_match');
  assert.equal(approved.publicMutationApplied, true);
  assert.equal(approved.autoApprovalResult.publicVersion, 1);

  const replay = await submit({ store, submission: second, runtimeEnv: enabled, now: NOW + 6001 });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.publicMutationApplied, false);
  assert.equal(replay.autoApprovalResult.duplicateApproval, true);

  const snapshot = await buildOrdinaryPublicSnapshot({ store, groupId: 'group_see', libraryId: 'lib_see_cz', now: NOW + 6002 });
  assert.equal(snapshot.publicVersion, 1);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].dataType, 'playable_name');
  assert.equal(snapshot.records[0].payload.name, '下雪');
});

test('同一老板不同普通内容进入人工审核且不发布公共版本', async () => {
  const store = new MemoryStore();
  const enabled = env({ CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1' });
  const first = makeSubmission({ deviceId: DEVICES[0], submissionId: SUBMISSIONS[0], dataType: 'boss_profile', payload: { bossName: '同一老板', paiDan: '直属A', discount: 0.9 } });
  const conflict = makeSubmission({ deviceId: DEVICES[1], submissionId: SUBMISSIONS[1], dataType: 'boss_profile', payload: { bossName: '同一老板', paiDan: '直属A', discount: 0.88 } });
  assert.equal(first.businessKey, conflict.businessKey);
  await submit({ store, submission: first, runtimeEnv: enabled, now: NOW });
  const result = await submit({ store, submission: conflict, runtimeEnv: enabled, now: NOW + 6000 });
  assert.equal(result.autoApprovalResult.status, 'pending_review');
  assert.equal(result.publicMutationApplied, false);
  assert.equal(result.autoApprovalResult.publicVersion, 0);
});

test('跨正式作用域和Authorization设备不一致在写入前失败关闭', async () => {
  const store = new MemoryStore();
  const valid = makeSubmission({ deviceId: DEVICES[0], submissionId: SUBMISSIONS[0], dataType: 'playable_name', payload: { name: '下雪' } });
  const outside = clone(valid);
  outside.groupId = 'group_other';
  await assert.rejects(
    () => acceptProductionOrdinarySubmission({
      store, authorization: 'Bearer token', rawSubmission: outside, env: env(), now: NOW,
      authenticate: authenticate(outside.deviceId),
    }),
    error => error instanceof ProductionWriteRuntimeError && error.code === 'PRODUCTION_SCOPE_FORBIDDEN',
  );
  await assert.rejects(
    () => acceptProductionOrdinarySubmission({
      store, authorization: 'Bearer token', rawSubmission: valid, env: env(), now: NOW,
      authenticate: authenticate(DEVICES[1]),
    }),
    error => error instanceof ProductionWriteRuntimeError && error.code === 'DEVICE_SCOPE_MISMATCH',
  );
  assert.equal(store.items.size, 0);
});

test('HTTP入口转发老板资料并保留阶段7Q响应语义', async () => {
  const submission = makeSubmission({ deviceId: DEVICES[0], submissionId: SUBMISSIONS[0], dataType: 'boss_profile', payload: { bossName: '测试老板', paiDan: '直属A', discount: 0.9 } });
  let receivedType = null;
  const response = await handleProductionSubmissionCreateRequest({ env: env(), request: post(submission) }, {
    createStore: () => new MemoryStore(),
    acceptProduction: async input => {
      receivedType = input.rawSubmission.dataType;
      return {
        submissionId: submission.submissionId,
        dataType: submission.dataType,
        duplicate: false,
        publicMutationAllowed: false,
        publicMutationApplied: false,
        autoApprovalEnabled: false,
        autoApprovalResult: null,
        stablePromotionAuthorized: false,
      };
    },
    now: () => NOW,
  });
  assert.equal(response.status, 202);
  assert.equal(receivedType, 'boss_profile');
  const body = await response.json();
  assert.equal(body.data.publicMutationAllowed, false);
  assert.equal(body.data.publicMutationApplied, false);
  assert.equal(body.data.autoApprovalEnabled, false);
  assert.equal(body.data.stablePromotionAuthorized, false);
});

test('公共Cloud Function仍只依赖模式分发器', () => {
  const route = fs.readFileSync(path.join(root, 'cloud-functions/api/submissions/create.js'), 'utf8');
  const http = fs.readFileSync(path.join(root, 'src/server/production_write_http_v1.js'), 'utf8');
  assert.match(route, /write_mode_dispatch_v1/u);
  assert.doesNotMatch(route, /ordinary_public_engine_v1|production_ordinary_types_runtime_v1/u);
  assert.match(http, /acceptProductionOrdinarySubmission/u);
});
