import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdminSessionCookie } from '../src/server/admin_auth_v1.js';
import {
  createProductionAdminSessionToken,
  readProductionAdminAuthConfig,
} from '../src/server/production_admin_auth_v1.js';
import {
  handleAdminExactReviewQueueByMode,
} from '../src/server/admin_review_mode_dispatch_v1.js';
import {
  handleProductionAdminExactReviewQueueRequest,
  handleProductionAdminOrdinaryReviewApproveRequest,
  readProductionAdminReviewConfig,
} from '../src/server/production_admin_review_http_v1.js';
import { adminReviewResolutionKey } from '../src/server/admin_review_key_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_620_000_000;

const SECRETS = Object.freeze({
  password: 'stage7t-admin-password-0000000000000000000001',
  client: 'stage7t-client-key-0000000000000000000000002',
  publicRate: 'stage7t-public-rate-000000000000000000000003',
  session: 'stage7t-session-secret-00000000000000000000004',
  adminRate: 'stage7t-admin-rate-000000000000000000000005',
  device: 'stage7t-device-ref-000000000000000000000006',
  rollback: 'stage7t-rollback-ref-00000000000000000000007',
  audit: 'stage7t-export-audit-000000000000000000000008',
});

function env(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '0',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0',
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
    CLOUD_ADMIN_PASSWORD: SECRETS.password,
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: SECRETS.client,
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: SECRETS.publicRate,
    CLOUD_ADMIN_SESSION_SECRET: SECRETS.session,
    CLOUD_ADMIN_RATE_LIMIT_SALT: SECRETS.adminRate,
    CLOUD_ADMIN_DEVICE_REF_SALT: SECRETS.device,
    CLOUD_ADMIN_ROLLBACK_REF_SALT: SECRETS.rollback,
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: SECRETS.audit,
    ...overrides,
  };
}

function cookie(runtimeEnv = env()) {
  const config = readProductionAdminAuthConfig(runtimeEnv);
  const session = createProductionAdminSessionToken({
    config,
    now: NOW,
    randomBytes: length => Buffer.alloc(length, 9),
  });
  return createAdminSessionCookie(session.token).split(';')[0];
}

test('通用审核归档Key支持正式library且拒绝无效作用域', () => {
  assert.equal(
    adminReviewResolutionKey('lib_see_cz', `rv_v1_${'A'.repeat(43)}`),
    `reviews/lib_see_cz/resolved/rv_v1_${'A'.repeat(43)}.json`,
  );
  assert.throws(() => adminReviewResolutionKey('see_cz', `rv_v1_${'A'.repeat(43)}`));
  assert.throws(() => adminReviewResolutionKey('lib_see_cz', 'bad-review'));
});

test('正式审核配置绑定公共生产Store和正式协议作用域', () => {
  const config = readProductionAdminReviewConfig(env());
  assert.equal(config.mode, 'production');
  assert.equal(config.storeName, 'cloud-collab-production-v1');
  assert.equal(config.groupId, 'group_see');
  assert.equal(config.libraryId, 'lib_see_cz');
  assert.equal(config.ordinaryTypesEnabled, true);
  assert.equal(config.mutationPreviewEnabled, true);
  assert.equal(config.stablePromotionAuthorized, false);
});

test('精确价格正式队列接受正式issuer会话并返回脱敏生产能力', async () => {
  let storeName = null;
  const response = await handleProductionAdminExactReviewQueueRequest({
    env: env(),
    request: new Request('https://admin.example.invalid/api/admin/reviews', {
      method: 'GET',
      headers: { Cookie: cookie(), 'Sec-Fetch-Site': 'same-origin' },
    }),
  }, {
    now: () => NOW + 1000,
    createStore: name => { storeName = name; return {}; },
    listQueue: async ({ config }) => ({
      scope: { groupId: config.groupId, libraryId: config.libraryId, syntheticFixtureOnly: false },
      total: 0,
      items: [],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(storeName, 'cloud-collab-production-v1');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.viewer.username, 'xiaxue');
  assert.equal(body.data.scope.groupId, 'group_see');
  assert.equal(body.data.capabilities.productionAdmin, true);
  assert.equal(body.data.capabilities.syntheticFixtureOnly, false);
  assert.equal(body.data.stablePromotionAuthorized, false);
});

test('普通审核批准使用正式会话、正式公共Store和显式动作', async () => {
  let captured = null;
  const response = await handleProductionAdminOrdinaryReviewApproveRequest({
    env: env(),
    request: new Request('https://admin.example.invalid/api/admin/ordinary-reviews/approve', {
      method: 'POST',
      headers: {
        Cookie: cookie(),
        Origin: 'https://admin.example.invalid',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reviewId: `rv_v1_${'B'.repeat(43)}`, confirmation: 'APPROVE_ORDINARY' }),
    }),
  }, {
    now: () => NOW + 1000,
    createStore: name => ({ name }),
    mutate: async input => {
      captured = input;
      return {
        reviewId: input.command.input.reviewId,
        action: input.command.action,
        status: 'approved_by_admin',
        publicMutationApplied: true,
      };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(captured.store.name, 'cloud-collab-production-v1');
  assert.equal(captured.config.libraryId, 'lib_see_cz');
  assert.equal(captured.identity.username, 'xiaxue');
  assert.equal(captured.command.action, 'approve');
  const body = await response.json();
  assert.equal(body.data.result.publicMutationApplied, true);
  assert.equal(body.data.capabilities.productionAdmin, true);
  assert.equal(body.data.stablePromotionAuthorized, false);
});

test('跨站管理员写入在创建公共Store前被拒绝', async () => {
  let storeCreates = 0;
  const response = await handleProductionAdminOrdinaryReviewApproveRequest({
    env: env(),
    request: new Request('https://admin.example.invalid/api/admin/ordinary-reviews/approve', {
      method: 'POST',
      headers: {
        Cookie: cookie(),
        Origin: 'https://evil.example.invalid',
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json',
      },
      body: '{}',
    }),
  }, {
    now: () => NOW,
    createStore: () => { storeCreates += 1; return {}; },
  });
  assert.equal(response.status, 403);
  assert.equal(storeCreates, 0);
});

test('管理员审核未开启时在Store创建前失败关闭', async () => {
  let storeCreates = 0;
  const disabled = env({ CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0' });
  const response = await handleProductionAdminExactReviewQueueRequest({
    env: disabled,
    request: new Request('https://admin.example.invalid/api/admin/reviews', {
      method: 'GET',
      headers: { Cookie: cookie(disabled), 'Sec-Fetch-Site': 'same-origin' },
    }),
  }, {
    now: () => NOW,
    createStore: () => { storeCreates += 1; return {}; },
  });
  assert.equal(response.status, 503);
  assert.equal(storeCreates, 0);
});

test('生产总开关开启时管理员子开关关闭不得回退预览审核', async () => {
  let stores = 0;
  const runtimeEnv = env({
    CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0',
    CLOUD_ADMIN_PASSWORD: '',
    CLOUD_ADMIN_SESSION_SECRET: '',
    CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_PREVIEW_ENABLED: '1',
    CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-admin-preview-v1',
    CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '1',
    CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  });
  const response = await handleAdminExactReviewQueueByMode({
    env: runtimeEnv,
    request: new Request('https://admin.example.invalid/api/admin/reviews', {
      method: 'GET',
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    }),
  }, {
    createStore: () => { stores += 1; return {}; },
    listQueue: async () => assert.fail('生产模式不得调用预览队列'),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PRODUCTION_ADMIN_DISABLED');
  assert.equal(stores, 0);
});

test('非法生产总开关在进入任一审核处理器前失败', async () => {
  let stores = 0;
  const response = await handleAdminExactReviewQueueByMode({
    env: { CLOUD_PRODUCTION_ENABLED: 'maybe', CLOUD_ADMIN_PRODUCTION_ENABLED: '1' },
    request: new Request('https://admin.example.invalid/api/admin/reviews', { method: 'GET' }),
  }, {
    createStore: () => { stores += 1; return {}; },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PRODUCTION_FLAG_INVALID');
  assert.equal(stores, 0);
});

test('十个Cloud Function审核入口只依赖模式分发器并保留旧处理器名', () => {
  const files = [
    ['cloud-functions/api/admin/reviews.js', 'handleAdminReviewQueueRequest'],
    ['cloud-functions/api/admin/reviews/detail.js', 'handleAdminReviewDetailRequest'],
    ['cloud-functions/api/admin/reviews/approve.js', 'handleAdminReviewApproveRequest'],
    ['cloud-functions/api/admin/reviews/reject.js', 'handleAdminReviewRejectRequest'],
    ['cloud-functions/api/admin/reviews/edit-and-approve.js', 'handleAdminReviewEditAndApproveRequest'],
    ['cloud-functions/api/admin/ordinary-reviews.js', 'handleAdminOrdinaryReviewQueueRequest'],
    ['cloud-functions/api/admin/ordinary-reviews/detail.js', 'handleAdminOrdinaryReviewDetailRequest'],
    ['cloud-functions/api/admin/ordinary-reviews/approve.js', 'handleAdminOrdinaryReviewApproveRequest'],
    ['cloud-functions/api/admin/ordinary-reviews/reject.js', 'handleAdminOrdinaryReviewRejectRequest'],
    ['cloud-functions/api/admin/ordinary-reviews/edit-and-approve.js', 'handleAdminOrdinaryReviewEditAndApproveRequest'],
  ];
  for (const [file, handler] of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /admin_review_mode_dispatch_v1/u);
    assert.match(source, new RegExp(handler, 'u'));
    assert.doesNotMatch(source, /from ['"][^'"]*(?:admin_review_http_v1|admin_review_mutation_http_v1|admin_ordinary_review_http_v1|admin_ordinary_review_mutation_http_v1)\.js['"]/u);
  }
});

test('正式审核HTTP只允许生产会话验证器且分发器只看生产总开关', () => {
  const http = fs.readFileSync(path.join(root, 'src/server/production_admin_review_http_v1.js'), 'utf8');
  const dispatch = fs.readFileSync(path.join(root, 'src/server/admin_review_mode_dispatch_v1.js'), 'utf8');
  assert.match(http, /verifyProductionAdminSessionToken/u);
  assert.doesNotMatch(http, /verifyAdminSessionToken/u);
  assert.match(dispatch, /resolveAdminAuthMode/u);
  assert.doesNotMatch(dispatch, /CLOUD_ADMIN_PRODUCTION_ENABLED/u);
});
