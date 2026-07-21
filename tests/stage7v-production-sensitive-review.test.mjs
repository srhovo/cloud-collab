import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdminSessionCookie } from '../src/server/admin_auth_v1.js';
import { createProductionAdminSessionToken, readProductionAdminAuthConfig } from '../src/server/production_admin_auth_v1.js';
import { handleAdminSensitiveReviewQueueByMode } from '../src/server/admin_sensitive_review_mode_dispatch_v1.js';
import {
  handleProductionAdminSensitiveReviewApproveRequest,
  handleProductionAdminSensitiveReviewQueueRequest,
  readProductionAdminSensitiveReviewConfig,
} from '../src/server/production_admin_sensitive_review_http_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_630_000_000;
const ORIGIN = 'https://admin.example.invalid';
const secret = label => `${label}-${'x'.repeat(40)}`;

function env(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '0',
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
    CLOUD_ADMIN_PUBLIC_ORIGIN: ORIGIN,
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: secret('password'),
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: secret('client'),
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: secret('public-rate'),
    CLOUD_ADMIN_SESSION_SECRET: secret('session'),
    CLOUD_ADMIN_RATE_LIMIT_SALT: secret('admin-rate'),
    CLOUD_ADMIN_DEVICE_REF_SALT: secret('device-ref'),
    CLOUD_ADMIN_ROLLBACK_REF_SALT: secret('rollback-ref'),
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: secret('audit-ref'),
    ...overrides,
  };
}

function cookie(runtimeEnv = env()) {
  const config = readProductionAdminAuthConfig(runtimeEnv);
  const token = createProductionAdminSessionToken({
    config,
    now: NOW,
    randomBytes: length => Buffer.alloc(length, 12),
  }).token;
  return createAdminSessionCookie(token).split(';')[0];
}

function request(pathName, { method = 'GET', body, origin = ORIGIN, runtimeEnv = env() } = {}) {
  return new Request(`${ORIGIN}${pathName}`, {
    method,
    headers: {
      Cookie: cookie(runtimeEnv),
      ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
      'Sec-Fetch-Site': origin === ORIGIN ? 'same-origin' : 'cross-site',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('production configuration uses the public production store and protocol scope', () => {
  const config = readProductionAdminSensitiveReviewConfig(env());
  assert.equal(config.storeName, 'cloud-collab-production-v1');
  assert.equal(config.groupId, 'group_see');
  assert.equal(config.libraryId, 'lib_see_cz');
  assert.equal(config.syntheticFixtureOnly, false);
  assert.equal(config.stablePromotionAuthorized, false);
});

test('queue accepts a production session and returns production capabilities', async () => {
  let storeName = null;
  const response = await handleProductionAdminSensitiveReviewQueueRequest({
    env: env(),
    request: request('/api/admin/sensitive-reviews'),
  }, {
    now: () => NOW + 1,
    createStore: name => { storeName = name; return {}; },
    listQueue: async ({ config }) => ({
      schemaVersion: 1,
      scope: { groupId: config.groupId, libraryId: config.libraryId },
      count: 0,
      items: [],
      capabilities: {},
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(storeName, 'cloud-collab-production-v1');
  const body = await response.json();
  assert.equal(body.data.viewer.username, 'xiaxue');
  assert.equal(body.data.capabilities.productionAdmin, true);
  assert.equal(body.data.capabilities.syntheticFixtureOnly, false);
  assert.equal(body.data.capabilities.manualReviewRequired, true);
  assert.equal(body.data.capabilities.automaticApproval, false);
  assert.equal(body.data.realSecretValuesExposed, false);
});

test('approval forwards the explicit command with production identity and store', async () => {
  const reviewId = `srv_v1_${'A'.repeat(43)}`;
  let captured = null;
  const response = await handleProductionAdminSensitiveReviewApproveRequest({
    env: env(),
    request: request('/api/admin/sensitive-reviews/approve', {
      method: 'POST', body: { reviewId, confirmation: 'APPROVE_SENSITIVE' },
    }),
  }, {
    now: () => NOW + 2,
    createStore: name => ({ name }),
    mutate: async value => {
      captured = value;
      return { schemaVersion: 1, duplicate: false, resolution: { reviewId, action: 'approve' }, publicResult: { version: 7, operation: 'upsert' } };
    },
  });
  assert.equal(response.status, 201);
  assert.equal(captured.store.name, 'cloud-collab-production-v1');
  assert.equal(captured.identity.username, 'xiaxue');
  assert.equal(captured.action, 'approve');
  assert.deepEqual(captured.input, { reviewId, confirmation: 'APPROVE_SENSITIVE' });
  const body = await response.json();
  assert.equal(body.data.result.publicResult.version, 7);
  assert.equal(body.data.capabilities.publicMutationAllowed, true);
  assert.equal(body.data.stablePromotionAuthorized, false);
});

test('cross-origin writes are blocked before body parsing and store creation', async () => {
  let stores = 0;
  const response = await handleProductionAdminSensitiveReviewApproveRequest({
    env: env(),
    request: request('/api/admin/sensitive-reviews/approve', {
      method: 'POST', body: {}, origin: 'https://other.example.invalid',
    }),
  }, { createStore: () => { stores += 1; return {}; } });
  assert.equal(response.status, 403);
  assert.equal(stores, 0);
});

test('production mode never falls back to preview when a child gate is closed', async () => {
  const closed = env({ CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0' });
  let stores = 0;
  const response = await handleAdminSensitiveReviewQueueByMode({
    env: {
      ...closed,
      CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED: '1',
      CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED: '1',
      CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
      CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID: 'group_fixture',
      CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
      CLOUD_SENSITIVE_REVIEW_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
      CLOUD_SENSITIVE_REVIEW_ALLOWED_GROUP_ID: 'group_fixture',
      CLOUD_SENSITIVE_REVIEW_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    },
    request: new Request(`${ORIGIN}/api/admin/sensitive-reviews`, { method: 'GET' }),
  }, { createStore: () => { stores += 1; return {}; } });
  assert.equal(response.status, 503);
  assert.equal(stores, 0);
});

test('an invalid production master gate fails before either handler', async () => {
  let stores = 0;
  const response = await handleAdminSensitiveReviewQueueByMode({
    env: { CLOUD_PRODUCTION_ENABLED: 'invalid' },
    request: new Request(`${ORIGIN}/api/admin/sensitive-reviews`, { method: 'GET' }),
  }, { createStore: () => { stores += 1; return {}; } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PRODUCTION_FLAG_INVALID');
  assert.equal(stores, 0);
});

test('all five cloud functions depend only on the mode dispatcher', () => {
  for (const [relative, handler] of [
    ['cloud-functions/api/admin/sensitive-reviews.js', 'handleAdminSensitiveReviewQueueByMode'],
    ['cloud-functions/api/admin/sensitive-reviews/detail.js', 'handleAdminSensitiveReviewDetailByMode'],
    ['cloud-functions/api/admin/sensitive-reviews/approve.js', 'handleAdminSensitiveReviewApproveByMode'],
    ['cloud-functions/api/admin/sensitive-reviews/reject.js', 'handleAdminSensitiveReviewRejectByMode'],
    ['cloud-functions/api/admin/sensitive-reviews/edit-and-approve.js', 'handleAdminSensitiveReviewEditAndApproveByMode'],
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, new RegExp(handler, 'u'));
    assert.match(source, /admin_sensitive_review_mode_dispatch_v1/u);
    assert.doesNotMatch(source, /from ['"][^'"]*admin_sensitive_review_http_v1/u);
  }
});

test('static boundaries use production sessions, master-gate dispatch, and no automatic approval', () => {
  const http = fs.readFileSync(path.join(root, 'src/server/production_admin_sensitive_review_http_v1.js'), 'utf8');
  const dispatch = fs.readFileSync(path.join(root, 'src/server/admin_sensitive_review_mode_dispatch_v1.js'), 'utf8');
  assert.match(http, /verifyProductionAdminSessionToken/u);
  assert.match(http, /mutateAdminSensitiveReview/u);
  assert.match(http, /automaticApproval:\s*false/u);
  assert.match(http, /stablePromotionAuthorized:\s*false/u);
  assert.doesNotMatch(http, /readAdminAuthConfig|verifyAdminSessionToken/u);
  assert.match(dispatch, /resolveAdminAuthMode/u);
  assert.doesNotMatch(dispatch, /CLOUD_ADMIN_PRODUCTION_ENABLED|CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED/u);
});
