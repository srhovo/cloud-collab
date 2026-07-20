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
  acceptProductionExactSubmission,
  acceptProductionOrdinarySubmission,
  assertProductionCandidateHandlerAvailable,
  readProductionWriteConfig,
} from '../src/server/production_write_runtime_v1.js';
import {
  handleProductionDeviceRegisterRequest,
  handleProductionSubmissionCreateRequest,
} from '../src/server/production_write_http_v1.js';

const NOW = 1_784_600_000_000;
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const ACCESS_KEY = 'stage7r-production-access-key-0123456789abcdef';

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
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: 'stage7r-production-rate-salt-0123456789abcdef',
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
    this.setCalls = 0;
  }

  async get(key) {
    return this.items.has(key) ? structuredClone(this.items.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    this.setCalls += 1;
    if (options.onlyIfNew && this.items.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.items.set(key, structuredClone(value));
  }

  async delete(key) {
    this.items.delete(key);
  }

  async list(options = {}) {
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
  submissionId,
  payload,
  groupId = 'group_see',
  libraryId = 'lib_see_cz',
  deviceId = DEVICE_A,
  operation = 'upsert',
} = {}) {
  const value = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId,
    libraryId,
    bossId: null,
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

function exactStub(overrides = {}) {
  return {
    dataType: 'exact_price',
    operation: 'upsert',
    ...overrides,
  };
}

function post(pathname, body, headers = {}) {
  return new Request(`https://app.example.invalid${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cloud-Collab-Access-Key': ACCESS_KEY,
      Authorization: 'Bearer dt_v1_stage7r',
      Origin: 'https://app.example.invalid',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test('陪玩名字和老板资料在自动审核关闭时进入不可变候选链', async () => {
  for (const submission of [playable(), boss()]) {
    let received = null;
    const result = await acceptProductionCandidateSubmission({
      store: new MemoryStore(),
      authorization: 'Bearer dt_v1_stage7r',
      rawSubmission: submission,
      env: env(),
      now: NOW,
      authenticate: async () => ({ deviceId: DEVICE_A, tokenVersion: 1 }),
      accept: async ({ rawSubmission }) => {
        received = rawSubmission;
        return {
          submissionId: rawSubmission.submissionId,
          idempotencyKey: rawSubmission.idempotencyKey,
          status: 'waiting_confirmation',
          decision: 'wait_for_confirmation',
          duplicate: false,
        };
      },
    });
    assert.equal(received.dataType, submission.dataType);
    assert.equal(result.dataType, submission.dataType);
    assert.equal(result.publicMutationAllowed, false);
    assert.equal(result.publicMutationApplied, false);
    assert.equal(result.autoApprovalEnabled, false);
    assert.equal(result.autoApprovalResult, null);
    assert.equal(result.stablePromotionAuthorized, false);
  }
});

test('陪玩名字真实接收器保存不可变候选并支持精确重放', async () => {
  const store = new MemoryStore();
  const submission = playable();
  const input = {
    store,
    authorization: 'Bearer dt_v1_stage7r',
    rawSubmission: submission,
    env: env(),
    now: NOW,
    authenticate: async () => ({ deviceId: DEVICE_A, tokenVersion: 1 }),
  };
  const first = await acceptProductionOrdinarySubmission(input);
  const replay = await acceptProductionOrdinarySubmission(input);
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(first.status, 'waiting_confirmation');
  assert.equal(store.items.has(pendingSubmissionKey('lib_see_cz', submission.idempotencyKey)), true);
});

test('老板身份由正式协议groupId和老板名稳定派生', () => {
  const submission = boss();
  assert.equal(submission.bossId, deriveBossId('group_see', '测试老板'));
  assert.match(submission.bossId, /^boss_v1_[A-Za-z0-9_-]{43}$/u);
});

test('联系方式、错误作用域和设备身份漂移失败关闭', async () => {
  const unsafe = playable();
  unsafe.payload.name = '联系我wx_abcd1234';
  await assert.rejects(
    () => acceptProductionOrdinarySubmission({
      store: new MemoryStore(),
      authorization: 'Bearer token',
      rawSubmission: unsafe,
      env: env(),
      now: NOW,
    }),
    error => error instanceof ProductionWriteRuntimeError && error.status === 400,
  );

  const outside = playable({ groupId: 'group_other' });
  await assert.rejects(
    () => acceptProductionOrdinarySubmission({
      store: new MemoryStore(),
      authorization: 'Bearer token',
      rawSubmission: outside,
      env: env(),
      now: NOW,
      authenticate: async () => ({ deviceId: DEVICE_A, tokenVersion: 1 }),
    }),
    error => error instanceof ProductionWriteRuntimeError && error.code === 'PRODUCTION_SCOPE_FORBIDDEN',
  );

  const valid = playable();
  await assert.rejects(
    () => acceptProductionOrdinarySubmission({
      store: new MemoryStore(),
      authorization: 'Bearer token',
      rawSubmission: valid,
      env: env(),
      now: NOW,
      authenticate: async () => ({ deviceId: 'dev_01JABCDEF0123456789XYZABCE', tokenVersion: 1 }),
    }),
    error => error instanceof ProductionWriteRuntimeError && error.code === 'DEVICE_SCOPE_MISMATCH',
  );
});

test('删除和敏感类型在读取生产配置前进入独立人工审核门禁', async () => {
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

test('未知类型返回普通白名单', () => {
  assert.throws(
    () => assertProductionCandidateHandlerAvailable({ dataType: 'unknown', operation: 'upsert' }),
    error => error instanceof ProductionWriteRuntimeError
      && error.code === 'UNSUPPORTED_PRODUCTION_DATA_TYPE'
      && error.details.allowedDataTypes.includes('exact_price')
      && error.details.allowedDataTypes.includes('playable_name')
      && error.details.allowedDataTypes.includes('boss_profile'),
  );
});

test('精确价格在自动审核开启时仍由既有处理器执行', async () => {
  const config = readProductionWriteConfig(env({ CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1' }));
  assert.deepEqual(assertProductionCandidateHandlerAvailable(exactStub(), config), {
    dataType: 'exact_price', operation: 'upsert',
  });

  const store = new MemoryStore();
  const rawSubmission = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId: 'sub_01JABCDEF0123456789XYZABCF',
    deviceId: DEVICE_A,
    groupId: 'group_see',
    libraryId: 'lib_see_cz',
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: NOW,
    businessKey: `bk_v1_${'A'.repeat(43)}`,
    contentHash: `ch_v1_${'B'.repeat(43)}`,
    idempotencyKey: `ik_v1_${'C'.repeat(43)}`,
    payload: { serviceName: '测试服务', settleType: 'round', unitPrice: 100 },
    clientContext: { appVersion: '8.2.31', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  const result = await acceptProductionExactSubmission({
    store,
    authorization: 'Bearer dt_v1_stage7r',
    rawSubmission,
    env: env({ CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1' }),
    now: NOW,
    authenticate: async () => ({ deviceId: DEVICE_A, tokenVersion: 1 }),
    accept: async ({ rawSubmission: normalized }) => {
      await store.setJSON(pendingSubmissionKey(normalized.libraryId, normalized.idempotencyKey), {
        schemaVersion: 1,
        submission: normalized,
      }, { onlyIfNew: true });
      return { submissionId: normalized.submissionId, duplicate: false };
    },
    review: async () => ({ status: 'auto_approved', publicMutationApplied: true, eventVersion: 1 }),
  });
  assert.equal(result.autoApprovalEnabled, true);
  assert.equal(result.publicMutationAllowed, true);
  assert.equal(result.publicMutationApplied, true);
  assert.equal(result.autoApprovalResult.status, 'auto_approved');
});

test('陪玩和老板在全局自动审核开启时于Store创建前失败关闭', async () => {
  for (const submission of [playable(), boss()]) {
    let createStoreCalls = 0;
    const response = await handleProductionSubmissionCreateRequest({
      env: env({ CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1' }),
      request: post('/api/submissions/create', submission),
    }, {
      createStore() {
        createStoreCalls += 1;
        return new MemoryStore();
      },
    });
    assert.equal(response.status, 503);
    assert.equal(createStoreCalls, 0);
    assert.equal((await response.json()).error.code, 'PRODUCTION_ORDINARY_TYPE_AUTO_APPROVAL_HANDLER_REQUIRED');
  }
});

test('正式HTTP返回陪玩候选状态且设备注册声明能力分层', async () => {
  const submission = playable();
  const response = await handleProductionSubmissionCreateRequest({
    env: env(),
    request: post('/api/submissions/create', submission),
  }, {
    createStore: () => new MemoryStore(),
    acceptProduction: async () => ({
      submissionId: submission.submissionId,
      dataType: 'playable_name',
      duplicate: false,
      publicMutationAllowed: false,
      publicMutationApplied: false,
      autoApprovalEnabled: false,
      autoApprovalResult: null,
    }),
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.data.dataType, 'playable_name');
  assert.equal(body.data.publicMutationApplied, false);

  const registration = await handleProductionDeviceRegisterRequest({
    env: env({ CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1' }),
    request: post('/api/device/register', { schemaVersion: 1 }),
  }, {
    createStore: () => new MemoryStore(),
    registerProduction: async () => ({ deviceId: DEVICE_A, deviceToken: 'dt_v1_stage7r' }),
  });
  const registrationBody = await registration.json();
  assert.deepEqual(registrationBody.data.supportedOrdinaryTypes, ['exact_price', 'playable_name', 'boss_profile']);
  assert.deepEqual(registrationBody.data.autoApprovalSupportedTypes, ['exact_price']);
  assert.equal(registrationBody.data.autoApprovalEnabled, true);
});
