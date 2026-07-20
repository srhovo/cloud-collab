import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { trustedDeviceKey } from '../src/server/auto_approval_v1.js';
import { pendingSubmissionKey } from '../src/server/blob_repository_v1.js';
import {
  listValidOrdinaryPublicEvents,
} from '../src/server/ordinary_public_engine_v1.js';
import {
  computeOrdinarySubmissionHashes,
} from '../src/server/ordinary_types_policy_v1.js';
import {
  ProductionWriteRuntimeError,
  acceptProductionOrdinarySubmission,
  acceptProductionSubmission,
} from '../src/server/production_write_runtime_v1.js';
import { handleProductionSubmissionCreateRequest } from '../src/server/production_write_http_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_600_000_000;
const ACCESS_KEY = 'stage7r-production-access-key-0123456789abcdef';
const RATE_SALT = 'stage7r-production-rate-salt-0123456789abcdef';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUB_B = 'sub_01JABCDEF0123456789XYZABCE';
const SUB_C = 'sub_01JABCDEF0123456789XYZABCF';

function env(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1',
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
  constructor() {
    this.items = new Map();
    this.reads = [];
    this.writes = [];
    this.lists = [];
  }
  clone(value) { return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)); }
  async get(key, options = {}) {
    this.reads.push({ key, options: this.clone(options) });
    return this.items.has(key) ? this.clone(this.items.get(key)) : null;
  }
  async setJSON(key, value, options = {}) {
    this.writes.push({ key, options: this.clone(options) });
    if (options.onlyIfNew && this.items.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.items.set(key, this.clone(value));
  }
  async delete(key) { this.items.delete(key); }
  async list(options = {}) {
    this.lists.push(this.clone(options));
    const prefix = String(options.prefix || '');
    return {
      blobs: [...this.items.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key, etag: `etag-${key.length}` })),
    };
  }
}

function ordinarySubmission({
  dataType,
  deviceId = DEVICE_A,
  submissionId = SUB_A,
  payload,
  bossId = null,
} = {}) {
  const value = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId: 'group_see',
    libraryId: 'lib_see_cz',
    bossId,
    dataType,
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: NOW,
    businessKey: `bk_v1_${'A'.repeat(43)}`,
    contentHash: `ch_v1_${'A'.repeat(43)}`,
    idempotencyKey: `ik_v1_${'A'.repeat(43)}`,
    payload,
    clientContext: { appVersion: '8.2.31', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  const computed = computeOrdinarySubmissionHashes(value);
  value.bossId = computed.submission.bossId;
  value.businessKey = computed.businessKey;
  value.contentHash = computed.contentHash;
  value.idempotencyKey = computed.idempotencyKey;
  return value;
}

function playable(options = {}) {
  return ordinarySubmission({ dataType: 'playable_name', payload: { name: '下雪' }, ...options });
}

function boss(options = {}) {
  return ordinarySubmission({
    dataType: 'boss_profile',
    payload: { bossName: '测试老板', paiDan: '小雪', discount: 0.95 },
    ...options,
  });
}

function identityFor(submission) {
  return async () => ({ deviceId: submission.deviceId, tokenVersion: 1 });
}

async function trust(store, deviceId) {
  await store.setJSON(trustedDeviceKey(deviceId), {
    schemaVersion: 1,
    deviceId,
    trusted: true,
    trustedAt: NOW - 1000,
    revokedAt: null,
  });
}

function post(submission) {
  return new Request('https://app.example.invalid/api/submissions/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cloud-Collab-Access-Key': ACCESS_KEY,
      Authorization: 'Bearer dt_v1_production',
      Origin: 'https://app.example.invalid',
    },
    body: JSON.stringify(submission),
  });
}

test('正式分发器只接受三种普通共享类型', async () => {
  const store = new MemoryStore();
  await assert.rejects(
    () => acceptProductionSubmission({ store, rawSubmission: { dataType: 'gift_rule' } }),
    error => error instanceof ProductionWriteRuntimeError
      && error.code === 'UNSUPPORTED_PRODUCTION_ORDINARY_DATA_TYPE'
      && error.status === 400,
  );
  assert.equal(store.reads.length, 0);
  assert.equal(store.writes.length, 0);
});

test('普通陪玩名字首次提交等待，第二台设备相同确认发布唯一公共事件', async () => {
  const store = new MemoryStore();
  const firstSubmission = playable({ deviceId: DEVICE_A, submissionId: SUB_A });
  const secondSubmission = playable({ deviceId: DEVICE_B, submissionId: SUB_B });

  const first = await acceptProductionSubmission({
    store,
    authorization: 'Bearer dt_v1_a',
    rawSubmission: firstSubmission,
    env: env(),
    now: NOW,
    authenticate: identityFor(firstSubmission),
  });
  const second = await acceptProductionSubmission({
    store,
    authorization: 'Bearer dt_v1_b',
    rawSubmission: secondSubmission,
    env: env(),
    now: NOW + 6000,
    authenticate: identityFor(secondSubmission),
  });

  assert.equal(first.dataType, 'playable_name');
  assert.equal(first.autoApprovalResult.status, 'waiting_confirmation');
  assert.equal(first.publicMutationApplied, false);
  assert.equal(second.autoApprovalResult.status, 'auto_approved');
  assert.equal(second.autoApprovalResult.approvalMode, 'two_devices_match');
  assert.equal(second.publicMutationApplied, true);
  const events = await listValidOrdinaryPublicEvents({ store, libraryId: 'lib_see_cz' });
  assert.equal(events.length, 1);
  assert.equal(events[0].dataType, 'playable_name');
  assert.deepEqual(events[0].approval.deviceIds, [DEVICE_A, DEVICE_B]);

  const replay = await acceptProductionSubmission({
    store,
    authorization: 'Bearer dt_v1_a',
    rawSubmission: firstSubmission,
    env: env(),
    now: NOW + 6000,
    authenticate: identityFor(firstSubmission),
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.autoApprovalResult.decision, 'duplicate_noop');
  assert.equal(replay.publicMutationApplied, false);
  assert.equal((await listValidOrdinaryPublicEvents({ store, libraryId: 'lib_see_cz' })).length, 1);
});

test('可信设备可批准新老板资料，但直属变化必须进入人工审核', async () => {
  const store = new MemoryStore();
  const initial = boss({ deviceId: DEVICE_A, submissionId: SUB_A });
  await trust(store, DEVICE_A);
  const approved = await acceptProductionOrdinarySubmission({
    store,
    authorization: 'Bearer dt_v1_a',
    rawSubmission: initial,
    env: env(),
    now: NOW,
    authenticate: identityFor(initial),
  });
  assert.equal(approved.autoApprovalResult.status, 'auto_approved');
  assert.equal(approved.autoApprovalResult.approvalMode, 'trusted_device');
  assert.equal(approved.publicMutationApplied, true);

  const changed = boss({
    deviceId: DEVICE_B,
    submissionId: SUB_C,
    payload: { bossName: '测试老板', paiDan: '其他直属', discount: 0.95 },
  });
  const pending = await acceptProductionSubmission({
    store,
    authorization: 'Bearer dt_v1_b',
    rawSubmission: changed,
    env: env(),
    now: NOW + 6000,
    authenticate: identityFor(changed),
  });
  assert.equal(changed.businessKey, initial.businessKey);
  assert.equal(pending.autoApprovalResult.status, 'pending_review');
  assert.equal(pending.autoApprovalResult.reason, 'boss_direct_report_change_sensitive');
  assert.equal(pending.publicMutationApplied, false);
  assert.equal((await listValidOrdinaryPublicEvents({ store, libraryId: 'lib_see_cz' })).length, 1);
});

test('老板折数升高和异常大幅降折均不得自动发布', async () => {
  for (const [discount, reason] of [
    [0.96, 'boss_discount_increase_sensitive'],
    [0.89, 'boss_discount_drop_abnormal'],
  ]) {
    const store = new MemoryStore();
    const initial = boss({ deviceId: DEVICE_A, submissionId: SUB_A });
    await trust(store, DEVICE_A);
    await acceptProductionSubmission({
      store, authorization: 'Bearer dt_v1_a', rawSubmission: initial, env: env(), now: NOW,
      authenticate: identityFor(initial),
    });
    const changed = boss({
      deviceId: DEVICE_B,
      submissionId: SUB_C,
      payload: { bossName: '测试老板', paiDan: '小雪', discount },
    });
    const result = await acceptProductionSubmission({
      store, authorization: 'Bearer dt_v1_b', rawSubmission: changed, env: env(), now: NOW + 6000,
      authenticate: identityFor(changed),
    });
    assert.equal(result.autoApprovalResult.status, 'pending_review');
    assert.equal(result.autoApprovalResult.reason, reason);
    assert.equal(result.publicMutationApplied, false);
    assert.equal((await listValidOrdinaryPublicEvents({ store, libraryId: 'lib_see_cz' })).length, 1);
  }
});

test('普通类型自动审核关闭时只入队且不会写公共事件', async () => {
  const store = new MemoryStore();
  const submission = playable();
  const result = await acceptProductionSubmission({
    store,
    authorization: 'Bearer dt_v1_a',
    rawSubmission: submission,
    env: env({ CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '0' }),
    now: NOW,
    authenticate: identityFor(submission),
  });
  assert.equal(result.autoApprovalEnabled, false);
  assert.equal(result.publicMutationAllowed, false);
  assert.equal(result.publicMutationApplied, false);
  assert.equal(result.autoApprovalResult, null);
  assert.ok(await store.get(pendingSubmissionKey('lib_see_cz', submission.idempotencyKey)));
  assert.equal((await listValidOrdinaryPublicEvents({ store, libraryId: 'lib_see_cz' })).length, 0);
});

test('联系方式与越界作用域在设备认证和限流写入前失败', async () => {
  for (const invalid of [
    playable({ payload: { name: '微信 wx123456' } }),
    playable({ groupId: 'group_other' }),
  ]) {
    const store = new MemoryStore();
    let authCalls = 0;
    await assert.rejects(
      () => acceptProductionSubmission({
        store,
        authorization: 'Bearer dt_v1_a',
        rawSubmission: invalid,
        env: env(),
        now: NOW,
        authenticate: async () => { authCalls += 1; return { deviceId: invalid.deviceId, tokenVersion: 1 }; },
      }),
      error => error instanceof ProductionWriteRuntimeError && [
        'ORDINARY_CONTACT_INFO_FORBIDDEN',
        'PRODUCTION_SCOPE_FORBIDDEN',
      ].includes(error.code),
    );
    assert.equal(authCalls, 0);
    assert.equal(store.writes.length, 0);
  }
});

test('正式HTTP对普通类型使用统一处理器并公开支持类型', async () => {
  const submission = playable();
  let receivedType = null;
  const response = await handleProductionSubmissionCreateRequest({
    env: env(),
    request: post(submission),
  }, {
    createStore: () => new MemoryStore(),
    acceptProduction: async input => {
      receivedType = input.rawSubmission.dataType;
      return {
        submissionId: submission.submissionId,
        dataType: submission.dataType,
        duplicate: false,
        publicMutationAllowed: true,
        publicMutationApplied: false,
        autoApprovalEnabled: true,
        autoApprovalResult: { status: 'waiting_confirmation' },
      };
    },
    now: () => NOW,
  });
  assert.equal(response.status, 202);
  assert.equal(receivedType, 'playable_name');
  const body = await response.json();
  assert.deepEqual(body.data.supportedDataTypes, ['exact_price', 'playable_name', 'boss_profile']);
  assert.equal(body.data.dataType, 'playable_name');
  assert.equal(body.data.autoApprovalResult.status, 'waiting_confirmation');
  assert.equal(body.data.stablePromotionAuthorized, false);
});

test('阶段7R复用阶段5G模块且不接入敏感类型、真实密钥或稳定晋升', () => {
  const runtime = fs.readFileSync(path.join(root, 'src/server/production_write_runtime_v1.js'), 'utf8');
  const http = fs.readFileSync(path.join(root, 'src/server/production_write_http_v1.js'), 'utf8');
  assert.match(runtime, /acceptOrdinarySubmission/u);
  assert.match(runtime, /reviewOrdinaryCandidate/u);
  assert.match(runtime, /normalizeOrdinarySubmission/u);
  assert.match(http, /acceptProductionSubmission/u);
  assert.doesNotMatch(runtime, /sensitive_submission_acceptance|reviewSensitiveCandidate/u);
  assert.doesNotMatch(`${runtime}\n${http}`, /stablePromotionAuthorized:\s*true/u);
  assert.doesNotMatch(`${runtime}\n${http}`, /ORDINARY_TYPES_SECRET|BOSS_PROFILE_SECRET/u);
  assert.doesNotMatch(http, /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*['"]/u);
});
