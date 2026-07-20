import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleStage5g6a6bDeviceRegisterRequest,
  handleStage5g6a6bOrdinarySubmissionRequest,
  handleStage5g6a6bPublicVersionRequest,
  handleStage5g6a6bSensitiveSubmissionRequest,
} from '../src/server/stage5g6a6b_acceptance_proxy_http_v1.js';

const acceptanceKey = 'acceptance-key-'.padEnd(40, 'a');
const previewKey = 'preview-key-'.padEnd(40, 'b');

function env(overrides = {}) {
  return {
    CLOUD_STAGE5G6A6B_ACCEPTANCE_ENABLED: '1',
    CLOUD_STAGE5G6A6B_ACCEPTANCE_KEY: acceptanceKey,
    CLOUD_STAGE5G6A6B_CLEANUP_ENABLED: '0',
    CLOUD_STAGE5G6A6B_CLEANUP_KEY: 'cleanup-key-'.padEnd(40, 'c'),
    CLOUD_WRITE_PREVIEW_ENABLED: '0',
    CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
    CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED: '1',
    CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED: '1',
    CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED: '1',
    CLOUD_ADMIN_PREVIEW_ENABLED: '1',
    CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '1',
    CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '1',
    CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_SENSITIVE_REVIEW_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-admin-preview-v1',
    CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_ORDINARY_TYPES_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_ORDINARY_TYPES_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_SENSITIVE_REVIEW_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_SENSITIVE_REVIEW_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_WRITE_PREVIEW_KEY: previewKey,
    CLOUD_RATE_LIMIT_SALT: 'rate-limit-'.padEnd(40, 'd'),
    CLOUD_ADMIN_PASSWORD: 'admin-password-'.padEnd(40, 'e'),
    CLOUD_ADMIN_SESSION_SECRET: 'admin-session-'.padEnd(40, 'f'),
    CLOUD_ADMIN_RATE_LIMIT_SALT: 'admin-rate-'.padEnd(40, 'g'),
    CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://acceptance.example.test',
    ...overrides,
  };
}

function request(path, {
  method = 'POST',
  body = {},
  includeAcceptance = true,
  includeOrigin = true,
} = {}) {
  const headers = new Headers({
    'Sec-Fetch-Site': 'same-origin',
    'X-Cloud-Collab-Preview-Key': previewKey,
    'Content-Type': 'application/json',
  });
  if (includeOrigin) headers.set('Origin', 'https://acceptance.example.test');
  if (includeAcceptance) headers.set('X-Cloud-Stage5g6a6b-Acceptance-Key', acceptanceKey);
  return new Request(`https://acceptance.example.test${path}`, {
    method,
    headers,
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

class MemoryStore {
  async get() { return null; }
  async setJSON() {}
  async delete() {}
  async list() { return { blobs: [] }; }
}

test('设备注册代理只在正式写入门禁关闭时内部临时启用fixture写入', async () => {
  let observedEnabled = null;
  const response = await handleStage5g6a6bDeviceRegisterRequest({
    request: request('/api/stage5g6a6b/acceptance/device-register'),
    env: env(),
  }, {
    createStore: () => new MemoryStore(),
    registerPreview: async ({ env: delegatedEnv }) => {
      observedEnabled = delegatedEnv.CLOUD_WRITE_PREVIEW_ENABLED;
      return { schemaVersion: 1, deviceId: 'dev_01JSTAGE5G6A6B000000000003', deviceToken: 'dt_v1_'.padEnd(49, 'A') };
    },
    now: () => 1_785_000_000_000,
  });
  assert.equal(response.status, 201);
  assert.equal(observedEnabled, '1');

  const unsafe = await handleStage5g6a6bDeviceRegisterRequest({
    request: request('/api/stage5g6a6b/acceptance/device-register'),
    env: env({ CLOUD_WRITE_PREVIEW_ENABLED: '1' }),
  });
  assert.equal(unsafe.status, 503);
});

test('普通候选代理内部开启自动审核但关闭敏感读取锁，正式环境仍保持关闭', async () => {
  let delegated = null;
  const response = await handleStage5g6a6bOrdinarySubmissionRequest({
    request: request('/api/stage5g6a6b/acceptance/ordinary-submissions-create'),
    env: env(),
  }, {
    createStore: () => new MemoryStore(),
    acceptAndReview: async ({ env: delegatedEnv }) => {
      delegated = delegatedEnv;
      return { duplicate: false, status: 'pending_review', decision: 'pending_review' };
    },
    now: () => 1_785_000_000_000,
  });
  assert.equal(response.status, 202);
  assert.equal(delegated.CLOUD_WRITE_PREVIEW_ENABLED, '1');
  assert.equal(delegated.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED, '1');
  assert.equal(delegated.CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED, '0');
});

test('敏感候选只向协议层传递严格公共基线投影', async () => {
  const businessKey = `bk_v1_${'B'.repeat(43)}`;
  const contentHash = `ch_v1_${'C'.repeat(43)}`;
  let observed = null;
  const response = await handleStage5g6a6bSensitiveSubmissionRequest({
    request: request('/api/stage5g6a6b/acceptance/sensitive-submissions-create', {
      body: { groupId: 'group_fixture', libraryId: 'lib_receive_fixture' },
    }),
    env: env(),
  }, {
    createStore: () => new MemoryStore(),
    buildSnapshot: async () => ({
      groupId: 'group_fixture',
      libraryId: 'lib_receive_fixture',
      publicVersion: 4,
      snapshotVersion: 4,
      baseOrdinaryVersion: 1,
      generatedAt: '2026-07-20T12:08:23.992Z',
      records: [{
        businessKey,
        contentHash,
        dataType: 'surcharge_rule',
        operation: 'upsert',
        approvedVersion: 3,
        payload: {
          name: '联合验收教学',
          keywords: ['教学', '教学单'],
          prices: { round: 5, hour: 20 },
          enabled: true,
        },
      }],
      tombstones: [],
    }),
    accept: async ({ resolveExistingRecord }) => {
      observed = await resolveExistingRecord({ businessKey });
      return { duplicate: false, status: 'pending_review', decision: 'pending_review' };
    },
    now: () => 1_785_000_000_000,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(observed, {
    businessKey,
    contentHash,
    dataType: 'surcharge_rule',
    bossId: null,
    payload: {
      name: '联合验收教学',
      keywords: ['教学', '教学单'],
      prices: { round: 5, hour: 20 },
      enabled: true,
    },
  });
  assert.deepEqual(Object.keys(observed).sort(), ['bossId', 'businessKey', 'contentHash', 'dataType', 'payload']);
});

test('写入代理缺少Origin时继续失败关闭', async () => {
  const response = await handleStage5g6a6bOrdinarySubmissionRequest({
    request: request('/api/stage5g6a6b/acceptance/ordinary-submissions-create', { includeOrigin: false }),
    env: env(),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ADMIN_REQUEST_ORIGIN_INVALID');
});

test('公共读取代理允许同源GET缺少Origin但仍要求验收密钥', async () => {
  const response = await handleStage5g6a6bPublicVersionRequest({
    request: request('/api/stage5g6a6b/acceptance/public-version?groupId=group_fixture&libraryId=lib_receive_fixture', {
      method: 'GET', includeOrigin: false,
    }),
    env: env(),
  }, {
    createStore: () => new MemoryStore(),
    buildSnapshot: async () => ({
      groupId: 'group_fixture', libraryId: 'lib_receive_fixture', publicVersion: 0,
      snapshotVersion: 0, baseOrdinaryVersion: 0, generatedAt: '2026-07-20T00:00:00.000Z',
      records: [], tombstones: [],
    }),
    now: () => 1_785_000_000_000,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.publicVersion, 0);

  const denied = await handleStage5g6a6bPublicVersionRequest({
    request: request('/api/stage5g6a6b/acceptance/public-version?groupId=group_fixture&libraryId=lib_receive_fixture', {
      method: 'GET', includeAcceptance: false, includeOrigin: false,
    }),
    env: env(),
  });
  assert.equal(denied.status, 403);
});
