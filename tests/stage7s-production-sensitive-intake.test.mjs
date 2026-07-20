import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeSensitiveSubmissionHashes } from '../src/server/sensitive_rules_policy_v1.js';
import {
  ProductionSensitiveRuntimeError,
  acceptProductionSensitiveCandidate,
  assertProductionSensitiveEnvelope,
  createProductionSensitiveBaselineResolver,
} from '../src/server/production_sensitive_runtime_v1.js';
import { handleProductionSensitiveSubmissionRequest } from '../src/server/production_sensitive_http_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_610_000_000;
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const ACCESS_KEY = 'stage7s-production-access-key-0123456789abcdef';

function secret(label) {
  return `${label}_${'z'.repeat(40)}`;
}

function enabledEnv(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '0',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '1',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '0',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: '',
    CLOUD_PRODUCTION_EXTERNAL_CLUB_ID: 'see',
    CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID: 'see_cz',
    CLOUD_PRODUCTION_GROUP_ID: 'group_see',
    CLOUD_PRODUCTION_LIBRARY_ID: 'lib_see_cz',
    CLOUD_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-production-v1',
    CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-admin-production-v1',
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://app.example.invalid',
    CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://admin.example.invalid',
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: secret('password'),
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: ACCESS_KEY,
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: secret('public-rate'),
    CLOUD_ADMIN_SESSION_SECRET: secret('session'),
    CLOUD_ADMIN_RATE_LIMIT_SALT: secret('admin-rate'),
    CLOUD_ADMIN_DEVICE_REF_SALT: secret('device-ref'),
    CLOUD_ADMIN_ROLLBACK_REF_SALT: secret('rollback-ref'),
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: secret('export-audit'),
    ...overrides,
  };
}

function disabledEnv() {
  return {
    CLOUD_PRODUCTION_ENABLED: '0',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '0',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '0',
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
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: '',
    CLOUD_ADMIN_PUBLIC_ORIGIN: '',
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: '',
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: '',
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_SESSION_SECRET: '',
    CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_DEVICE_REF_SALT: '',
    CLOUD_ADMIN_ROLLBACK_REF_SALT: '',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
  };
}

class MemoryStore {
  constructor() {
    this.items = new Map();
    this.setCalls = 0;
  }
  async get(key) { return this.items.has(key) ? structuredClone(this.items.get(key)) : null; }
  async setJSON(key, value, options = {}) {
    this.setCalls += 1;
    if (options.onlyIfNew && this.items.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.items.set(key, structuredClone(value));
  }
  async delete(key) { this.items.delete(key); }
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

function complete(raw) {
  const computed = computeSensitiveSubmissionHashes(raw);
  return {
    ...raw,
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    idempotencyKey: computed.idempotencyKey,
  };
}

function draft(dataType, payload, overrides = {}) {
  return {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId: 'sub_01JABCDEF0123456789XYZABCD',
    deviceId: DEVICE_A,
    groupId: 'group_see',
    libraryId: 'lib_see_cz',
    bossId: null,
    dataType,
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: NOW - 1000,
    businessKey: `bk_v1_${'A'.repeat(43)}`,
    contentHash: `ch_v1_${'B'.repeat(43)}`,
    idempotencyKey: `ik_v1_${'C'.repeat(43)}`,
    payload,
    clientContext: {
      appVersion: '8.2.31',
      projectionSpecVersion: 1,
      queueSchemaVersion: 1,
    },
    ...overrides,
  };
}

function gift(overrides = {}) {
  return complete(draft('gift_rule', {
    serviceName: '红包',
    mode: 'fixed',
    unitPrice: 66,
  }, overrides));
}

function exactDelete(overrides = {}) {
  return complete(draft('exact_price', null, {
    operation: 'delete',
    ...overrides,
  }));
}

function post(body, headers = {}) {
  return new Request('https://app.example.invalid/api/sensitive-submissions/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cloud-Collab-Access-Key': ACCESS_KEY,
      Authorization: 'Bearer dt_v1_stage7s',
      Origin: 'https://app.example.invalid',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test('礼物规则正式入队并精确重放，公共库保持不变', async () => {
  const store = new MemoryStore();
  const submission = gift();
  const input = {
    store,
    authorization: 'Bearer dt_v1_stage7s',
    rawSubmission: submission,
    env: enabledEnv(),
    now: NOW,
    authenticate: async () => ({ deviceId: DEVICE_A, tokenVersion: 1 }),
  };
  const first = await acceptProductionSensitiveCandidate(input);
  const replay = await acceptProductionSensitiveCandidate(input);
  assert.equal(first.status, 'pending_review');
  assert.equal(first.reason, 'gift_rule_manual_review');
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(first.manualReviewRequired, true);
  assert.equal(first.publicMutationAllowed, false);
  assert.equal(first.publicMutationApplied, false);
  assert.equal(first.autoApprovalEnabled, false);
  assert.equal(first.stablePromotionAuthorized, false);
  assert.deepEqual(first.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.deepEqual(first.protocolScope, { groupId: 'group_see', libraryId: 'lib_see_cz' });
});

test('显式删除必须解析正式公共基线', async () => {
  const submission = exactDelete();
  const baseline = {
    businessKey: submission.businessKey,
    contentHash: `ch_v1_${'D'.repeat(43)}`,
    dataType: 'exact_price',
    bossId: null,
    payload: { serviceName: '测试服务', settleType: 'round', unitPrice: 88 },
  };
  const result = await acceptProductionSensitiveCandidate({
    store: new MemoryStore(),
    authorization: 'Bearer dt_v1_stage7s',
    rawSubmission: submission,
    env: enabledEnv(),
    now: NOW,
    authenticate: async () => ({ deviceId: DEVICE_A, tokenVersion: 1 }),
    resolveExistingRecord: async query => {
      assert.equal(query.groupId, 'group_see');
      assert.equal(query.libraryId, 'lib_see_cz');
      return baseline;
    },
  });
  assert.equal(result.reason, 'explicit_delete_manual_review');

  await assert.rejects(
    () => acceptProductionSensitiveCandidate({
      store: new MemoryStore(),
      authorization: 'Bearer dt_v1_stage7s',
      rawSubmission: submission,
      env: enabledEnv(),
      now: NOW,
      authenticate: async () => ({ deviceId: DEVICE_A, tokenVersion: 1 }),
      resolveExistingRecord: async () => null,
    }),
    error => error.code === 'DELETE_TARGET_NOT_FOUND',
  );
});

test('默认基线解析器拒绝作用域漂移并精确查找记录', async () => {
  const query = {
    groupId: 'group_see',
    libraryId: 'lib_see_cz',
    dataType: 'gift_rule',
    businessKey: 'bk_test',
    bossId: null,
  };
  const expected = { ...query, contentHash: 'ch_test', payload: { mode: 'fixed', unitPrice: 66 } };
  const resolver = createProductionSensitiveBaselineResolver({
    store: new MemoryStore(),
    now: NOW,
    buildSnapshot: async () => ({
      groupId: 'group_see', libraryId: 'lib_see_cz', records: [expected],
    }),
  });
  assert.deepEqual(await resolver(query), expected);

  const badResolver = createProductionSensitiveBaselineResolver({
    store: new MemoryStore(),
    now: NOW,
    buildSnapshot: async () => ({ groupId: 'group_other', libraryId: 'lib_see_cz', records: [] }),
  });
  await assert.rejects(
    () => badResolver(query),
    error => error instanceof ProductionSensitiveRuntimeError
      && error.code === 'PRODUCTION_SENSITIVE_BASELINE_SCOPE_MISMATCH',
  );
});

test('普通upsert、未知操作、错误作用域和设备身份失败关闭', async () => {
  assert.throws(
    () => assertProductionSensitiveEnvelope({ dataType: 'exact_price', operation: 'upsert' }),
    error => error instanceof ProductionSensitiveRuntimeError
      && error.code === 'PRODUCTION_ORDINARY_HANDLER_REQUIRED',
  );
  assert.throws(
    () => assertProductionSensitiveEnvelope({ dataType: 'gift_rule', operation: 'patch' }),
    error => error instanceof ProductionSensitiveRuntimeError
      && error.code === 'UNSUPPORTED_PRODUCTION_SENSITIVE_TYPE',
  );

  const outside = gift({ groupId: 'group_other' });
  await assert.rejects(
    () => acceptProductionSensitiveCandidate({
      store: new MemoryStore(), authorization: 'Bearer token', rawSubmission: outside,
      env: enabledEnv(), now: NOW,
    }),
    error => error instanceof ProductionSensitiveRuntimeError
      && error.code === 'PRODUCTION_SENSITIVE_SCOPE_FORBIDDEN',
  );

  await assert.rejects(
    () => acceptProductionSensitiveCandidate({
      store: new MemoryStore(), authorization: 'Bearer token', rawSubmission: gift(),
      env: enabledEnv(), now: NOW,
      authenticate: async () => ({ deviceId: DEVICE_B, tokenVersion: 1 }),
    }),
    error => error instanceof ProductionSensitiveRuntimeError
      && error.code === 'DEVICE_SCOPE_MISMATCH',
  );
});

test('关闭状态和错误访问密钥在正文与Store之前阻断', async () => {
  for (const [runtimeEnv, key, expectedCode] of [
    [disabledEnv(), ACCESS_KEY, 'PRODUCTION_SENSITIVE_SUBMISSION_DISABLED'],
    [enabledEnv(), 'wrong', 'PRODUCTION_ACCESS_DENIED'],
  ]) {
    let createStoreCalls = 0;
    const response = await handleProductionSensitiveSubmissionRequest({
      env: runtimeEnv,
      request: new Request('https://app.example.invalid/api/sensitive-submissions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-Cloud-Collab-Access-Key': key },
        body: 'not-json',
      }),
    }, {
      createStore() {
        createStoreCalls += 1;
        return new MemoryStore();
      },
    });
    assert.equal(createStoreCalls, 0);
    assert.equal((await response.json()).error.code, expectedCode);
  }
});

test('HTTP只允许精确来源、POST和受限OPTIONS', async () => {
  const response = await handleProductionSensitiveSubmissionRequest({
    env: enabledEnv(),
    request: post(gift()),
  }, {
    createStore: () => new MemoryStore(),
    acceptProduction: async () => ({
      submissionId: 'sub_01JABCDEF0123456789XYZABCD',
      status: 'pending_review',
      decision: 'pending_review',
      duplicate: false,
    }),
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.invalid');
  assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
  const body = await response.json();
  assert.equal(body.reviewMode, 'manual_only');
  assert.equal(body.data.manualReviewRequired, true);
  assert.equal(body.data.publicMutationAllowed, false);

  const getResponse = await handleProductionSensitiveSubmissionRequest({
    env: enabledEnv(),
    request: new Request('https://app.example.invalid/api/sensitive-submissions/create', { method: 'GET' }),
  });
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get('allow'), 'POST, OPTIONS');

  const options = await handleProductionSensitiveSubmissionRequest({
    env: enabledEnv(),
    request: new Request('https://app.example.invalid/api/sensitive-submissions/create', {
      method: 'OPTIONS', headers: { Origin: 'https://app.example.invalid' },
    }),
  });
  assert.equal(options.status, 204);
  assert.match(options.headers.get('access-control-allow-headers'), /X-Cloud-Collab-Access-Key/u);
});

test('正式Cloud Function只指向生产敏感处理器', () => {
  const source = fs.readFileSync(path.join(root, 'cloud-functions/api/sensitive-submissions/create.js'), 'utf8');
  assert.match(source, /handleProductionSensitiveSubmissionRequest/u);
  assert.doesNotMatch(source, /preview/u);
});
