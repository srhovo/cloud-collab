import assert from 'node:assert/strict';
import test from 'node:test';

import { pendingSubmissionKey } from '../src/server/blob_repository_v1.js';
import {
  computeOrdinarySubmissionHashes,
  deriveBossId,
} from '../src/server/ordinary_types_policy_v1.js';
import {
  ProductionWriteRuntimeError,
  acceptProductionCandidateSubmission,
  acceptProductionOrdinarySubmission,
} from '../src/server/production_write_runtime_v1.js';
import {
  handleProductionDeviceRegisterRequest,
  handleProductionSubmissionCreateRequest,
} from '../src/server/production_write_http_v1.js';

const NOW = 1_784_580_100_000;
const DEVICE = 'dev_01JABCDEF0123456789XYZABCD';
const ACCESS_KEY = 'stage7q-production-access-key-0123456789abcdef';

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
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: 'stage7q-production-rate-salt-0123456789abcdef',
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
}

function ordinarySubmission({
  dataType,
  submissionId,
  payload,
  bossId = null,
  deviceId = DEVICE,
  operation = 'upsert',
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
    operation,
    origin: 'user',
    clientCreatedAt: NOW,
    businessKey: `bk_v1_${'A'.repeat(43)}`,
    contentHash: `ch_v1_${'B'.repeat(43)}`,
    idempotencyKey: `ik_v1_${'C'.repeat(43)}`,
    payload,
    clientContext: { appVersion: '8.2.31', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  const computed = computeOrdinarySubmissionHashes(value);
  value.businessKey = computed.businessKey;
  value.contentHash = computed.contentHash;
  value.idempotencyKey = computed.idempotencyKey;
  value.bossId = computed.submission.bossId;
  return value;
}

function playable(overrides = {}) {
  return ordinarySubmission({
    dataType: 'playable_name',
    submissionId: 'sub_01JABCDEF0123456789XYZABCD',
    payload: { name: '小雨' },
    ...overrides,
  });
}

function boss(overrides = {}) {
  return ordinarySubmission({
    dataType: 'boss_profile',
    submissionId: 'sub_01JABCDEF0123456789XYZABCE',
    payload: { bossName: '测试老板', paiDan: '小雨', discount: 0.95 },
    ...overrides,
  });
}

function post(body, headers = {}) {
  return new Request('https://app.example.invalid/api/submissions/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cloud-Collab-Access-Key': ACCESS_KEY,
      Authorization: 'Bearer dt_v1_stage7q',
      Origin: 'https://app.example.invalid',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test('陪玩名字与老板资料通过统一正式候选分发', async () => {
  for (const submission of [playable(), boss()]) {
    const store = new MemoryStore();
    let acceptedType = null;
    const result = await acceptProductionCandidateSubmission({
      store,
      authorization: 'Bearer dt_v1_stage7q',
      rawSubmission: submission,
      env: env(),
      now: NOW,
      authenticate: async () => ({ deviceId: DEVICE, tokenVersion: 1 }),
      accept: async ({ rawSubmission }) => {
        acceptedType = rawSubmission.dataType;
        return {
          schemaVersion: 1,
          submissionId: rawSubmission.submissionId,
          idempotencyKey: rawSubmission.idempotencyKey,
          dataType: rawSubmission.dataType,
          status: 'waiting_confirmation',
          decision: 'wait_for_confirmation',
          duplicate: false,
        };
      },
    });
    assert.equal(acceptedType, submission.dataType);
    assert.equal(result.dataType, submission.dataType);
    assert.equal(result.publicMutationAllowed, false);
    assert.equal(result.autoApprovalEnabled, false);
    assert.equal(result.stablePromotionAuthorized, false);
    assert.deepEqual(result.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  }
});

test('正式普通接收器真实写入不可变候选并支持精确重放', async () => {
  const store = new MemoryStore();
  const submission = playable();
  const input = {
    store,
    authorization: 'Bearer dt_v1_stage7q',
    rawSubmission: submission,
    env: env(),
    now: NOW,
    authenticate: async () => ({ deviceId: DEVICE, tokenVersion: 1 }),
  };
  const first = await acceptProductionOrdinarySubmission(input);
  const second = await acceptProductionOrdinarySubmission(input);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.status, 'waiting_confirmation');
  assert.equal(store.items.has(pendingSubmissionKey('lib_see_cz', submission.idempotencyKey)), true);
});

test('老板身份由groupId和老板名稳定派生', () => {
  const submission = boss();
  assert.equal(submission.bossId, deriveBossId('group_see', '测试老板'));
  assert.match(submission.bossId, /^boss_v1_[A-Za-z0-9_-]{43}$/u);
});

test('联系方式、错误作用域和错误设备身份均失败关闭', async () => {
  const unsafe = playable();
  unsafe.payload.name = '联系我wx_abcd1234';
  await assert.rejects(
    () => acceptProductionCandidateSubmission({
      store: new MemoryStore(), authorization: 'Bearer token', rawSubmission: unsafe, env: env(), now: NOW,
    }),
    error => error instanceof ProductionWriteRuntimeError && error.status === 400,
  );

  const outside = playable();
  outside.groupId = 'group_other';
  await assert.rejects(
    () => acceptProductionOrdinarySubmission({
      store: new MemoryStore(), authorization: 'Bearer token', rawSubmission: outside, env: env(), now: NOW,
    }),
    error => error instanceof ProductionWriteRuntimeError && error.status === 400,
  );

  const valid = playable();
  await assert.rejects(
    () => acceptProductionOrdinarySubmission({
      store: new MemoryStore(), authorization: 'Bearer token', rawSubmission: valid, env: env(), now: NOW,
      authenticate: async () => ({ deviceId: 'dev_01JABCDEF0123456789XYZABCE', tokenVersion: 1 }),
    }),
    error => error instanceof ProductionWriteRuntimeError && error.code === 'DEVICE_SCOPE_MISMATCH',
  );
});

test('删除和敏感规则类型必须走独立人工审核处理器', async () => {
  for (const rawSubmission of [
    { ...playable(), operation: 'delete' },
    { dataType: 'rank_range_rule', operation: 'upsert' },
    { dataType: 'surcharge_rule', operation: 'upsert' },
    { dataType: 'gift_rule', operation: 'upsert' },
  ]) {
    await assert.rejects(
      () => acceptProductionCandidateSubmission({ rawSubmission }),
      error => error instanceof ProductionWriteRuntimeError
        && error.code === 'PRODUCTION_SENSITIVE_HANDLER_REQUIRED',
    );
  }
});

test('未知普通类型返回白名单而不访问Store', async () => {
  await assert.rejects(
    () => acceptProductionCandidateSubmission({ rawSubmission: { dataType: 'unknown', operation: 'upsert' } }),
    error => error instanceof ProductionWriteRuntimeError
      && error.code === 'UNSUPPORTED_PRODUCTION_DATA_TYPE'
      && error.details.allowedDataTypes.includes('playable_name')
      && error.details.allowedDataTypes.includes('boss_profile'),
  );
});

test('正式HTTP使用统一候选处理器并返回普通类型', async () => {
  const submission = playable();
  let received = null;
  const response = await handleProductionSubmissionCreateRequest({
    env: env(), request: post(submission),
  }, {
    createStore: () => new MemoryStore(),
    acceptProduction: async input => {
      received = input.rawSubmission;
      return { submissionId: submission.submissionId, dataType: submission.dataType, duplicate: false };
    },
    now: () => NOW,
  });
  assert.equal(response.status, 202);
  assert.equal(received.dataType, 'playable_name');
  const body = await response.json();
  assert.equal(body.data.dataType, 'playable_name');
  assert.equal(body.data.publicMutationAllowed, false);
  assert.equal(body.data.autoApprovalEnabled, false);
});

test('设备注册响应声明三个普通候选类型', async () => {
  const response = await handleProductionDeviceRegisterRequest({
    env: env(),
    request: new Request('https://app.example.invalid/api/device/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cloud-Collab-Access-Key': ACCESS_KEY,
        Origin: 'https://app.example.invalid',
      },
      body: JSON.stringify({ schemaVersion: 1 }),
    }),
  }, {
    createStore: () => new MemoryStore(),
    registerProduction: async () => ({ deviceId: DEVICE, deviceToken: 'dt_v1_stage7q' }),
  });
  const body = await response.json();
  assert.deepEqual(body.data.supportedOrdinaryTypes, ['exact_price', 'playable_name', 'boss_profile']);
});

test('自动审核开关仍在正文和Store之前阻断三个普通类型', async () => {
  for (const submission of [playable(), boss()]) {
    let storeCalls = 0;
    const response = await handleProductionSubmissionCreateRequest({
      env: env({ CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1' }),
      request: post(submission),
    }, { createStore() { storeCalls += 1; return new MemoryStore(); } });
    assert.equal(response.status, 503);
    assert.equal(storeCalls, 0);
    assert.equal((await response.json()).error.code, 'PRODUCTION_AUTO_APPROVAL_HANDLER_REQUIRED');
  }
});
