import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { pendingSubmissionKey } from '../src/server/blob_repository_v1.js';
import {
  buildIdempotencyKey,
  computeSubmissionHashes,
} from '../src/server/submission_policy_v1.js';
import {
  ProductionWriteRuntimeError,
  acceptProductionExactSubmission,
  assertProductionRequestAccess,
  consumeProductionRateSlot,
  productionRateKey,
  readProductionWriteConfig,
  registerProductionDevice,
} from '../src/server/production_write_runtime_v1.js';
import {
  handleProductionDeviceRegisterRequest,
  handleProductionSubmissionCreateRequest,
} from '../src/server/production_write_http_v1.js';
import {
  dispatchDeviceRegisterRequest,
  dispatchSubmissionCreateRequest,
} from '../src/server/write_mode_dispatch_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_580_000_000;
const ACCESS_KEY = 'production-client-access-key-0123456789abcdef';
const RATE_SALT = 'production-rate-limit-salt-0123456789abcdef';

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

const PREVIEW_ENV = Object.freeze({
  CLOUD_PRODUCTION_ENABLED: '0',
  CLOUD_WRITE_PREVIEW_ENABLED: '1',
  CLOUD_WRITE_PREVIEW_KEY: 'stage7p-preview-access-key-0123456789',
  CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_RATE_LIMIT_SALT: 'stage7p-preview-rate-limit-salt-0123456789',
  CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
});

class MemoryStore {
  constructor() { this.items = new Map(); }
  async get(key) { return this.items.has(key) ? structuredClone(this.items.get(key)) : null; }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.items.has(key)) throw new Error('already exists');
    this.items.set(key, structuredClone(value));
  }
  async delete(key) { this.items.delete(key); }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

const RAW = Object.freeze({
  schemaVersion: 1,
  payloadSchemaVersion: 1,
  submissionId: 'sub_01JABCDEF0123456789XYZABCD',
  deviceId: 'dev_01JABCDEF0123456789XYZABCD',
  groupId: 'group_see',
  libraryId: 'lib_see_cz',
  bossId: null,
  dataType: 'exact_price',
  operation: 'upsert',
  origin: 'user',
  clientCreatedAt: NOW,
  businessKey: 'bk_v1_0000000000000000000000000000000000000000000',
  contentHash: 'ch_v1_0000000000000000000000000000000000000000000',
  idempotencyKey: 'ik_v1_0000000000000000000000000000000000000000000',
  payload: { serviceName: '测试服务A', settleType: 'round', unitPrice: 110 },
  clientContext: { appVersion: '8.2.31', projectionSpecVersion: 1, queueSchemaVersion: 1 },
});

function makeSubmission(overrides = {}) {
  const value = { ...clone(RAW), ...overrides };
  value.payload = { ...RAW.payload, ...(overrides.payload || {}) };
  value.clientContext = { ...RAW.clientContext, ...(overrides.clientContext || {}) };
  value.idempotencyKey = buildIdempotencyKey(value.deviceId, value.submissionId);
  const hashes = computeSubmissionHashes(value);
  value.businessKey = hashes.businessKey;
  value.contentHash = hashes.contentHash;
  return value;
}

function post(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cloud-Collab-Access-Key': ACCESS_KEY,
      Origin: 'https://app.example.invalid',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function expectCode(code, fn) {
  return assert.rejects(fn, error => error instanceof ProductionWriteRuntimeError && error.code === code);
}

test('正式写配置、访问密钥和作用域正确', () => {
  const config = readProductionWriteConfig(env());
  assert.equal(config.allowedGroupId, 'group_see');
  assert.equal(config.allowedLibraryId, 'lib_see_cz');
  assert.deepEqual(config.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.equal(assertProductionRequestAccess(post('https://app.example.invalid/', {}), config), true);
  assert.throws(
    () => assertProductionRequestAccess(post('https://app.example.invalid/', {}, { 'X-Cloud-Collab-Access-Key': 'wrong' }), config),
    error => error instanceof ProductionWriteRuntimeError && error.code === 'PRODUCTION_ACCESS_DENIED',
  );
});

test('正式限流Key不暴露设备ID、盐值或访问密钥', () => {
  const key = productionRateKey({
    scope: 'submission-create', subject: RAW.deviceId, salt: RATE_SALT, now: NOW, slotMs: 5000,
  });
  assert.match(key, /^production-rate\/submission-create\/[A-Za-z0-9_-]{43}\/[0-9]+\.json$/u);
  assert.equal(key.includes(RAW.deviceId), false);
  assert.equal(key.includes(RATE_SALT), false);
  assert.equal(key.includes(ACCESS_KEY), false);
});

test('同一限流窗口只允许一次设备注册', async () => {
  const store = new MemoryStore();
  const input = { schemaVersion: 1, deviceId: RAW.deviceId, nickname: '下雪', clientContext: { appVersion: '8.2.31' } };
  let calls = 0;
  const register = async () => { calls += 1; return { deviceId: RAW.deviceId, deviceToken: 'dt_v1_test' }; };
  await registerProductionDevice({ store, input, env: env(), now: NOW, register });
  await expectCode('PRODUCTION_RATE_LIMITED', () => registerProductionDevice({ store, input, env: env(), now: NOW, register }));
  assert.equal(calls, 1);
});

test('正式提交只接受协议作用域并核对设备身份', async () => {
  const store = new MemoryStore();
  const outside = makeSubmission({ groupId: 'group_other' });
  await expectCode('PRODUCTION_SCOPE_FORBIDDEN', () => acceptProductionExactSubmission({
    store,
    authorization: 'Bearer dt_v1_test',
    rawSubmission: outside,
    env: env(),
    now: NOW,
    authenticate: async () => ({ deviceId: outside.deviceId, tokenVersion: 1 }),
    accept: async () => assert.fail('outside scope must not persist'),
  }));

  const valid = makeSubmission();
  await expectCode('DEVICE_SCOPE_MISMATCH', () => acceptProductionExactSubmission({
    store,
    authorization: 'Bearer dt_v1_test',
    rawSubmission: valid,
    env: env(),
    now: NOW,
    authenticate: async () => ({ deviceId: 'dev_01JABCDEF0123456789XYZABCE', tokenVersion: 1 }),
    accept: async () => assert.fail('wrong device must not persist'),
  }));
});

test('外部显示ID不能直接冒充协议提交ID', async () => {
  const external = clone(RAW);
  external.groupId = 'see';
  external.libraryId = 'see_cz';
  const store = new MemoryStore();
  await assert.rejects(
    () => acceptProductionExactSubmission({
      store,
      authorization: 'Bearer dt_v1_test',
      rawSubmission: external,
      env: env(),
      now: NOW,
    }),
    error => error instanceof ProductionWriteRuntimeError && error.status === 400,
  );
  assert.equal(store.items.size, 0);
});

test('精确重放绕过限流，新提交在同一窗口被限制', async () => {
  const store = new MemoryStore();
  const first = makeSubmission();
  const identity = { deviceId: first.deviceId, tokenVersion: 1 };
  const accept = async ({ rawSubmission }) => {
    const key = pendingSubmissionKey(rawSubmission.libraryId, rawSubmission.idempotencyKey);
    const duplicate = Boolean(await store.get(key));
    if (!duplicate) await store.setJSON(key, { schemaVersion: 1, submission: rawSubmission }, { onlyIfNew: true });
    return { submissionId: rawSubmission.submissionId, duplicate };
  };
  const firstResult = await acceptProductionExactSubmission({
    store, authorization: 'Bearer dt_v1_test', rawSubmission: first, env: env(), now: NOW,
    authenticate: async () => identity, accept,
  });
  const retry = await acceptProductionExactSubmission({
    store, authorization: 'Bearer dt_v1_test', rawSubmission: first, env: env(), now: NOW,
    authenticate: async () => identity, accept,
  });
  assert.equal(firstResult.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.publicMutationAllowed, false);
  assert.equal(retry.stablePromotionAuthorized, false);

  const second = makeSubmission({ submissionId: 'sub_01JABCDEF0123456789XYZABCE' });
  await expectCode('PRODUCTION_RATE_LIMITED', () => acceptProductionExactSubmission({
    store, authorization: 'Bearer dt_v1_test', rawSubmission: second, env: env(), now: NOW,
    authenticate: async () => identity, accept,
  }));
});

test('关闭状态和错误访问密钥都在解析正文及创建Store前阻断', async () => {
  for (const [runtimeEnv, suppliedKey, expected] of [
    [{ ...env(), CLOUD_PRODUCTION_ENABLED: '0', CLOUD_PRODUCTION_READ_SYNC_ENABLED: '0', CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '0', CLOUD_PRODUCTION_PUBLIC_ORIGIN: '', CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: '', CLOUD_PRODUCTION_RATE_LIMIT_SALT: '' }, ACCESS_KEY, 'PRODUCTION_ORDINARY_SUBMISSION_DISABLED'],
    [env(), 'wrong', 'PRODUCTION_ACCESS_DENIED'],
  ]) {
    let storeCalls = 0;
    const response = await handleProductionDeviceRegisterRequest({
      env: runtimeEnv,
      request: new Request('https://app.example.invalid/api/device/register', {
        method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Cloud-Collab-Access-Key': suppliedKey }, body: 'not-json',
      }),
    }, { createStore() { storeCalls += 1; return new MemoryStore(); } });
    const body = await response.json();
    assert.equal(body.error.code, expected);
    assert.equal(storeCalls, 0);
  }
});

test('正式注册HTTP只对精确来源授权并返回明确关闭的审核标志', async () => {
  const result = { deviceId: RAW.deviceId, deviceToken: 'dt_v1_production', issuedAt: NOW, expiresAt: NOW + 1000 };
  const response = await handleProductionDeviceRegisterRequest({
    env: env(),
    request: post('https://app.example.invalid/api/device/register', { schemaVersion: 1 }),
  }, {
    createStore: () => new MemoryStore(),
    registerProduction: async () => result,
    now: () => NOW,
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.invalid');
  assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
  const body = await response.json();
  assert.equal(body.data.deviceToken, 'dt_v1_production');
  assert.equal(body.data.submissionEnabled, true);
  assert.equal(body.data.publicMutationAllowed, false);
  assert.equal(body.data.autoApprovalEnabled, false);
});

test('正式精确价格HTTP转发Authorization并返回202候选状态', async () => {
  const submission = makeSubmission();
  let authorization = null;
  const response = await handleProductionSubmissionCreateRequest({
    env: env(),
    request: post('https://app.example.invalid/api/submissions/create', submission, { Authorization: 'Bearer dt_v1_production' }),
  }, {
    createStore: () => new MemoryStore(),
    acceptProduction: async input => {
      authorization = input.authorization;
      return { submissionId: submission.submissionId, duplicate: false };
    },
    now: () => NOW,
  });
  assert.equal(response.status, 202);
  assert.equal(authorization, 'Bearer dt_v1_production');
  const body = await response.json();
  assert.equal(body.data.publicMutationAllowed, false);
  assert.equal(body.data.autoApprovalEnabled, false);
  assert.equal(body.data.stablePromotionAuthorized, false);
});

test('自动审核开关开启时当前普通入队路由失败关闭而不创建Store', async () => {
  let storeCalls = 0;
  const response = await handleProductionSubmissionCreateRequest({
    env: env({ CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1' }),
    request: post('https://app.example.invalid/api/submissions/create', makeSubmission()),
  }, { createStore() { storeCalls += 1; return new MemoryStore(); } });
  assert.equal(response.status, 503);
  assert.equal(storeCalls, 0);
  assert.equal((await response.json()).error.code, 'PRODUCTION_AUTO_APPROVAL_HANDLER_REQUIRED');
});

test('共享路由按显式生产总开关分发且非法值失败关闭', async () => {
  const productionResponse = await dispatchDeviceRegisterRequest({
    env: env(), request: post('https://app.example.invalid/api/device/register', { schemaVersion: 1 }),
  }, {
    production: {
      createStore: () => new MemoryStore(),
      registerProduction: async () => ({ deviceId: RAW.deviceId, deviceToken: 'dt_v1_production' }),
    },
  });
  assert.equal((await productionResponse.json()).serviceId, 'cloud-collab-production-write');

  const previewRequest = new Request('https://preview.example.invalid/api/device/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cloud-Collab-Preview-Key': PREVIEW_ENV.CLOUD_WRITE_PREVIEW_KEY },
    body: '{}',
  });
  const previewResponse = await dispatchDeviceRegisterRequest({ env: PREVIEW_ENV, request: previewRequest }, {
    preview: {
      createStore: () => new MemoryStore(),
      registerPreview: async () => ({ deviceId: RAW.deviceId, deviceToken: 'dt_v1_preview' }),
    },
  });
  assert.equal((await previewResponse.json()).serviceId, 'cloud-collab-preview-write');

  const invalid = await dispatchSubmissionCreateRequest({
    env: { CLOUD_PRODUCTION_ENABLED: 'maybe' },
    request: new Request('https://example.invalid/api/submissions/create', { method: 'POST' }),
  });
  assert.equal(invalid.status, 503);
  assert.equal((await invalid.json()).error.code, 'PRODUCTION_FLAG_INVALID');
});

test('公共Cloud Function路由使用模式分发器', () => {
  const registerSource = fs.readFileSync(path.join(root, 'cloud-functions/api/device/register.js'), 'utf8');
  const submissionSource = fs.readFileSync(path.join(root, 'cloud-functions/api/submissions/create.js'), 'utf8');
  assert.match(registerSource, /dispatchDeviceRegisterRequest/u);
  assert.match(submissionSource, /dispatchSubmissionCreateRequest/u);
  assert.doesNotMatch(registerSource, /preview_write_http_v1/u);
  assert.doesNotMatch(submissionSource, /preview_write_http_v1/u);
});

test('正式写路由只允许POST和受限OPTIONS', async () => {
  const response = await handleProductionDeviceRegisterRequest({
    env: env(), request: new Request('https://app.example.invalid/api/device/register', { method: 'GET' }),
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST, OPTIONS');

  const options = await handleProductionDeviceRegisterRequest({
    env: env(), request: new Request('https://app.example.invalid/api/device/register', {
      method: 'OPTIONS', headers: { Origin: 'https://app.example.invalid' },
    }),
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), 'https://app.example.invalid');
  assert.match(options.headers.get('access-control-allow-headers'), /X-Cloud-Collab-Access-Key/u);
});
