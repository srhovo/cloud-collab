import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminSessionCookie } from '../src/server/admin_auth_v1.js';
import {
  createProductionAdminSessionToken,
  readProductionAdminAuthConfig,
} from '../src/server/production_admin_auth_v1.js';
import {
  ProductionAdminExportBundleError,
  buildProductionAdminExportBundle,
} from '../src/server/production_admin_export_bundle_v1.js';
import {
  PRODUCTION_ADMIN_EXPORT_CONFIRMATION,
} from '../src/server/production_admin_export_v1.js';
import {
  buildProductionExportAuditIdentity,
  handleProductionAdminExportDownloadRequest,
} from '../src/server/production_admin_export_http_v1.js';

const NOW = 1_784_670_000_000;
const ADMIN_ORIGIN = 'https://admin.example.invalid';
const secret = label => `${label}-${'x'.repeat(40)}`;

const CONFIG = Object.freeze({
  productionEnabled: true,
  storeName: 'cloud-collab-production-v1',
  groupId: 'group_see',
  libraryId: 'lib_see_cz',
  externalScope: Object.freeze({ clubId: 'see', libraryId: 'see_cz' }),
});

function emptySnapshot(overrides = {}) {
  return Object.freeze({
    schemaVersion: 2,
    payloadSchemaVersion: 1,
    groupId: 'group_see',
    libraryId: 'lib_see_cz',
    baseOrdinaryVersion: 0,
    publicVersion: 0,
    snapshotVersion: 0,
    cursor: 'pv_0',
    generatedAt: new Date(NOW).toISOString(),
    records: Object.freeze([]),
    tombstones: Object.freeze([]),
    ...overrides,
  });
}

function ordinaryEvent(version) {
  return Object.freeze({
    schemaVersion: 1,
    version,
    eventKey: `public/lib_see_cz/events/${String(version).padStart(12, '0')}.json`,
    approvalId: `ap_v1_${'A'.repeat(43)}`,
    groupId: 'group_see',
    libraryId: 'lib_see_cz',
    approvedAt: new Date(NOW + version).toISOString(),
    businessKey: `bk_v1_${'B'.repeat(43)}`,
    contentHash: `ch_v1_${'C'.repeat(43)}`,
    dataType: 'exact_price',
    operation: 'upsert',
    payload: Object.freeze({ serviceName: '测试', settleType: 'round', unitPrice: 1 }),
    baseline: Object.freeze({ approvedVersion: 0, contentHash: null, unitPrice: null }),
    approval: Object.freeze({
      mode: 'admin_approved',
      deviceIds: Object.freeze([]),
      submissionIds: Object.freeze([]),
    }),
  });
}

function runtimeEnv(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '0',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0',
    CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED: '0',
    CLOUD_PRODUCTION_EXPORT_ENABLED: '1',
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
    CLOUD_ADMIN_PUBLIC_ORIGIN: ADMIN_ORIGIN,
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: secret('password'),
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: secret('client'),
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: secret('public-rate'),
    CLOUD_ADMIN_SESSION_SECRET: secret('session'),
    CLOUD_ADMIN_RATE_LIMIT_SALT: secret('admin-rate'),
    CLOUD_ADMIN_DEVICE_REF_SALT: '',
    CLOUD_ADMIN_ROLLBACK_REF_SALT: '',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: secret('export-audit'),
    ...overrides,
  };
}

function sessionCookie(env = runtimeEnv()) {
  const config = readProductionAdminAuthConfig(env);
  const token = createProductionAdminSessionToken({
    config,
    now: NOW,
    randomBytes: length => Buffer.alloc(length, 16),
  }).token;
  return createAdminSessionCookie(token).split(';')[0];
}

function request(body, env = runtimeEnv()) {
  return new Request(`${ADMIN_ORIGIN}/api/admin/exports/download`, {
    method: 'POST',
    headers: {
      Cookie: sessionCookie(env),
      Origin: ADMIN_ORIGIN,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function command() {
  return Object.freeze({
    schemaVersion: 1,
    requestId: `exrq_v1_${'A'.repeat(22)}`,
    confirmation: PRODUCTION_ADMIN_EXPORT_CONFIRMATION,
  });
}

test('正式导出稳定状态必须通过前读、快照和后读三段一致性校验', async () => {
  let ordinaryReads = 0;
  let sensitiveReads = 0;
  let snapshotReads = 0;
  const bundle = await buildProductionAdminExportBundle({
    store: {},
    config: CONFIG,
    now: NOW,
    listOrdinaryEvents: async () => { ordinaryReads += 1; return []; },
    listSensitiveEvents: async ({ ordinaryVersion }) => {
      sensitiveReads += 1;
      assert.equal(ordinaryVersion, 0);
      return [];
    },
    buildSnapshot: async () => { snapshotReads += 1; return emptySnapshot(); },
  });
  assert.equal(bundle.publicVersion, 0);
  assert.equal(ordinaryReads, 2);
  assert.equal(sensitiveReads, 2);
  assert.equal(snapshotReads, 1);
});

test('导出期间公共事件追加时返回409，不生成快照与审计历史不一致的ZIP', async () => {
  let ordinaryReads = 0;
  await assert.rejects(
    () => buildProductionAdminExportBundle({
      store: {},
      config: CONFIG,
      now: NOW,
      listOrdinaryEvents: async () => {
        ordinaryReads += 1;
        return ordinaryReads === 1 ? [] : [ordinaryEvent(1)];
      },
      listSensitiveEvents: async () => [],
      buildSnapshot: async () => emptySnapshot(),
    }),
    error => error instanceof ProductionAdminExportBundleError
      && error.code === 'PRODUCTION_EXPORT_PUBLIC_STATE_MOVED'
      && error.status === 409,
  );
  assert.equal(ordinaryReads, 2);
});

test('统一快照版本与前后事件链不一致时返回409', async () => {
  await assert.rejects(
    () => buildProductionAdminExportBundle({
      store: {},
      config: CONFIG,
      now: NOW,
      listOrdinaryEvents: async () => [],
      listSensitiveEvents: async () => [],
      buildSnapshot: async () => emptySnapshot({
        publicVersion: 1,
        snapshotVersion: 1,
        cursor: 'pv_1',
      }),
    }),
    error => error instanceof ProductionAdminExportBundleError
      && error.code === 'PRODUCTION_EXPORT_PUBLIC_STATE_MOVED'
      && error.status === 409,
  );
});

test('底层公共基线409统一映射为可重试的导出状态变化错误', async () => {
  const baseMoved = Object.assign(new Error('base moved'), {
    code: 'SENSITIVE_PUBLIC_BASE_MOVED',
    status: 409,
    details: { expected: 1, actual: 2 },
  });
  await assert.rejects(
    () => buildProductionAdminExportBundle({
      store: {},
      config: CONFIG,
      now: NOW,
      listOrdinaryEvents: async () => { throw baseMoved; },
      listSensitiveEvents: async () => [],
      buildSnapshot: async () => emptySnapshot(),
    }),
    error => error.code === 'PRODUCTION_EXPORT_PUBLIC_STATE_MOVED'
      && error.status === 409
      && error.details.expected === 1,
  );
});

test('正式导出审计身份由独立盐HMAC生成且不包含真实用户名', () => {
  const identity = Object.freeze({
    username: 'xiaxue',
    sessionIdSuffix: '8B01',
    expiresAt: NOW + 900_000,
  });
  const first = buildProductionExportAuditIdentity(identity, {
    auditSalt: secret('audit-first'),
  });
  const replay = buildProductionExportAuditIdentity(identity, {
    auditSalt: secret('audit-first'),
  });
  const rotated = buildProductionExportAuditIdentity(identity, {
    auditSalt: secret('audit-second'),
  });
  assert.equal(first.username, replay.username);
  assert.notEqual(first.username, rotated.username);
  assert.equal(first.username.includes('xiaxue'), false);
  assert.match(first.username, /^export-audit-[A-Za-z0-9_-]{43}$/u);
  assert.equal(first.sessionIdSuffix, identity.sessionIdSuffix);
});

test('正式下载HTTP只向审计核心传递HMAC伪名并声明未授权稳定晋升', async () => {
  let capturedIdentity = null;
  const response = await handleProductionAdminExportDownloadRequest({
    env: runtimeEnv(),
    request: request(command()),
  }, {
    now: () => NOW,
    createStore: () => ({}),
    createDownload: async ({ identity }) => {
      capturedIdentity = identity;
      return Object.freeze({
        bytes: Buffer.from('zip'),
        byteLength: 3,
        packageId: `pkg_v2_${'A'.repeat(43)}`,
        publicVersion: 0,
        duplicate: false,
        filename: '码单器公共数据库-see-see_cz-v0.zip',
        contentType: 'application/zip',
      });
    },
  });
  assert.equal(response.status, 200);
  assert.ok(capturedIdentity);
  assert.equal(capturedIdentity.username.includes('xiaxue'), false);
  assert.match(capturedIdentity.username, /^export-audit-[A-Za-z0-9_-]{43}$/u);
  assert.equal(response.headers.get('x-cloud-collab-stable-promotion-authorized'), '0');
});
