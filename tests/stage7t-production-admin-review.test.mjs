import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createAdminSessionCookie,
  verifyAdminSessionToken,
} from '../src/server/admin_auth_v1.js';
import {
  createProductionAdminSessionToken,
  readProductionAdminAuthConfig,
  verifyProductionAdminSessionToken,
} from '../src/server/production_admin_auth_v1.js';
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

function productionSession(runtimeEnv = env()) {
  const config = readProductionAdminAuthConfig(runtimeEnv);
  const session = createProductionAdminSessionToken({
    config,
    now: NOW,
    randomBytes: length => Buffer.alloc(length, 9),
  });
  return { config, session };
}

function cookie(runtimeEnv = env()) {
  const { session } = productionSession(runtimeEnv);
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

test('正式审核只接受正式issuer会话并拒绝预览验证器', () => {
  const { config, session } = productionSession();
  const identity = verifyProductionAdminSessionToken(session.token, config, { now: NOW + 1000 });
  assert.equal(identity.username, 'xiaxue');
  assert.throws(
    () => verifyAdminSessionToken(session.token, config, { now: NOW + 1000 }),
    error => error.code === 'ADMIN_SESSION_INVALID',
  );
});

test('精确价格正式队列使用公共Store并返回脱敏生产能力', async () => {
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

test('伪造的预览issuer令牌不能访问正式审核', async () => {
  const production = productionSession();
  const forgedPreviewToken = (() => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      iss: 'cloud-collab-admin-preview',
      aud: 'cloud-collab-admin-preview',
      sub: 'xiaxue',
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 900,
      jti: Buffer.alloc(16, 9).toString('base64url'),
    }), 'utf8').toString('base64url');
    const signature = production.session.token.split('.')[2];
    return `${header}.${payload}.${signature}`;
  })();
  let storeCreates = 0;
  const response = await handleProductionAdminExactReviewQueueRequest({
    env: env(),
    request: new Request('https://admin.example.invalid/api/admin/reviews', {
      method: 'GET',
      headers: {
        Cookie: `cloud_admin_session=${forgedPreviewToken}`,
        'Sec-Fetch-Site': 'same-origin',
      },
    }),
  }, {
    now: () => NOW + 1000,
    createStore: () => { storeCreates += 1; return {}; },
  });
  assert.equal(response.status, 401);
  assert.equal(storeCreates, 0);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/u);
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

test('正式审核源代码不再导入预览会话验证器', () => {
  const source = fs.readFileSync(path.join(root, 'src/server/production_admin_review_http_v1.js'), 'utf8');
  assert.match(source, /verifyProductionAdminSessionToken/u);
  assert.match(source, /production_admin_auth_v1/u);
  assert.doesNotMatch(source, /\bverifyAdminSessionToken\b/u);
  assert.doesNotMatch(source, /readProductionAdminAuthConfig[^\n]*production_admin_auth_http_v1/u);
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
