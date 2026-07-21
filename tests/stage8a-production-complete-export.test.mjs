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
import { readProductionRuntimeConfig } from '../src/server/production_runtime_config_v1.js';
import { buildProductionAdminExportBundle } from '../src/server/production_admin_export_bundle_v1.js';
import {
  PRODUCTION_ADMIN_EXPORT_CONFIRMATION,
  ProductionAdminExportError,
  createProductionAdminExportDownload,
} from '../src/server/production_admin_export_v1.js';
import {
  handleProductionAdminExportDownloadRequest,
  handleProductionAdminExportSummaryRequest,
  readProductionAdminExportConfig,
} from '../src/server/production_admin_export_http_v1.js';
import { handleAdminExportSummaryByMode } from '../src/server/admin_export_mode_dispatch_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_660_000_000;
const ADMIN_ORIGIN = 'https://admin.example.invalid';
const secret = label => `${label}-${'x'.repeat(40)}`;

function env(overrides = {}) {
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

class MemoryStore {
  constructor() {
    this.items = new Map();
    this.lists = [];
  }

  clone(value) {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  async get(key) {
    return this.items.has(key) ? this.clone(this.items.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.items.has(key)) throw new Error('already exists');
    this.items.set(key, this.clone(value));
  }

  async delete(key) {
    this.items.delete(key);
  }

  async list(options = {}) {
    this.lists.push(this.clone(options));
    const prefix = String(options.prefix || '');
    return {
      blobs: [...this.items.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
}

function cookie(runtimeEnv = env()) {
  const config = readProductionAdminAuthConfig(runtimeEnv);
  const token = createProductionAdminSessionToken({
    config,
    now: NOW,
    randomBytes: length => Buffer.alloc(length, 15),
  }).token;
  return createAdminSessionCookie(token).split(';')[0];
}

function request(pathname, {
  method = 'GET',
  body,
  origin = ADMIN_ORIGIN,
  runtimeEnv = env(),
} = {}) {
  return new Request(`${ADMIN_ORIGIN}${pathname}`, {
    method,
    headers: {
      Cookie: cookie(runtimeEnv),
      'Sec-Fetch-Site': origin === ADMIN_ORIGIN ? 'same-origin' : 'cross-site',
      ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function exportCommand(requestId = `exrq_v1_${'A'.repeat(22)}`) {
  return {
    schemaVersion: 1,
    requestId,
    confirmation: PRODUCTION_ADMIN_EXPORT_CONFIRMATION,
  };
}

function parseStoredZip(bytes) {
  const buffer = Buffer.from(bytes);
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const filenameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + filenameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + filenameLength).toString('utf8');
    entries.set(name, buffer.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

function fakeBundle(version = 7) {
  return Object.freeze({
    bytes: Buffer.from(`zip-${version}`),
    byteLength: 5,
    fileCount: 15,
    packageId: `pkg_v2_${String(version).repeat(43).slice(0, 43)}`,
    generatedAt: new Date(NOW).toISOString(),
    publicVersion: version,
    recordCount: 6,
    tombstoneCount: 1,
    ordinaryEventCount: 3,
    sensitiveEventCount: 4,
    countsByType: Object.freeze({
      exact_price: 1,
      playable_name: 1,
      boss_profile: 1,
      rank_range_rule: 1,
      surcharge_rule: 1,
      gift_rule: 1,
    }),
    filename: `码单器公共数据库-see-see_cz-v${version}.zip`,
    contentType: 'application/zip',
  });
}

test('正式导出开关独立于人工审核和设备治理', () => {
  const runtime = readProductionRuntimeConfig(env());
  assert.equal(runtime.flags.export, true);
  assert.equal(runtime.flags.adminReview, false);
  assert.equal(runtime.flags.deviceGovernance, false);
  const config = readProductionAdminExportConfig(env());
  assert.equal(config.storeName, 'cloud-collab-production-v1');
  assert.equal(config.groupId, 'group_see');
  assert.equal(config.libraryId, 'lib_see_cz');
  assert.deepEqual(config.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.equal(config.auditSalt, secret('export-audit'));
});

test('导出要求只读同步、管理员身份和独立审计盐', () => {
  assert.throws(
    () => readProductionRuntimeConfig(env({ CLOUD_PRODUCTION_READ_SYNC_ENABLED: '0' })),
    error => error.code === 'PRODUCTION_ROLLOUT_ORDER_INVALID',
  );
  assert.throws(
    () => readProductionRuntimeConfig(env({
      CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
      CLOUD_ADMIN_PASSWORD: '',
      CLOUD_ADMIN_SESSION_SECRET: '',
      CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    })),
    error => error.code === 'PRODUCTION_ROLLOUT_ORDER_INVALID',
  );
  assert.throws(
    () => readProductionRuntimeConfig(env({ CLOUD_ADMIN_EXPORT_AUDIT_SALT: '' })),
    error => error.code === 'PRODUCTION_SECRET_INVALID',
  );
});

test('真实空库导出ZIP包含完整恢复目录且不含凭据', async () => {
  const store = new MemoryStore();
  const config = readProductionAdminExportConfig(env());
  const bundle = await buildProductionAdminExportBundle({ store, config, now: NOW });
  assert.equal(bundle.publicVersion, 0);
  assert.equal(bundle.recordCount, 0);
  assert.equal(bundle.tombstoneCount, 0);
  assert.equal(bundle.ordinaryEventCount, 0);
  assert.equal(bundle.sensitiveEventCount, 0);
  assert.equal(bundle.fileCount, 15);
  assert.match(bundle.packageId, /^pkg_v2_[A-Za-z0-9_-]{43}$/u);
  const entries = parseStoredZip(bundle.bytes);
  for (const name of [
    '码单器公共数据库导出/manifest.json',
    '码单器公共数据库导出/snapshot/all.json',
    '码单器公共数据库导出/exact-prices/index.json',
    '码单器公共数据库导出/playable-names/index.json',
    '码单器公共数据库导出/bosses/index.json',
    '码单器公共数据库导出/rules/rank-ranges.json',
    '码单器公共数据库导出/rules/surcharges.json',
    '码单器公共数据库导出/rules/gifts.json',
    '码单器公共数据库导出/tombstones/index.json',
    '码单器公共数据库导出/audit/ordinary-public-events.json',
    '码单器公共数据库导出/audit/sensitive-public-events.json',
  ]) assert.ok(entries.has(name), name);
  const allText = [...entries.values()].map(value => value.toString('utf8')).join('\n');
  assert.equal(/password|cloud_admin_session|authorization/i.test(allText), false);
});

test('同一导出请求在公共版本不变时精确重放且写入不可变审计', async () => {
  const store = new MemoryStore();
  const config = readProductionAdminExportConfig(env());
  const identity = { username: 'xiaxue' };
  const buildBundle = async () => fakeBundle(7);
  const first = await createProductionAdminExportDownload({
    store,
    config,
    identity,
    command: exportCommand(),
    now: NOW,
    buildBundle,
  });
  const second = await createProductionAdminExportDownload({
    store,
    config,
    identity,
    command: exportCommand(),
    now: NOW + 5000,
    buildBundle,
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.packageId, second.packageId);
  assert.equal([...store.items.keys()].filter(key => key.includes('/production/requests/')).length, 1);
  assert.equal([...store.items.keys()].filter(key => key.includes('/production/decisions/')).length, 1);
  assert.equal([...store.items.keys()].filter(key => key.startsWith('audit/')).length, 1);
  assert.equal(JSON.stringify([...store.items.values()]).includes(secret('export-audit')), false);
});

test('同一请求ID在公共版本变化后409并要求新请求ID', async () => {
  const store = new MemoryStore();
  const config = readProductionAdminExportConfig(env());
  const identity = { username: 'xiaxue' };
  let version = 7;
  const buildBundle = async () => fakeBundle(version);
  await createProductionAdminExportDownload({
    store,
    config,
    identity,
    command: exportCommand(),
    now: NOW,
    buildBundle,
  });
  version = 8;
  await assert.rejects(
    () => createProductionAdminExportDownload({
      store,
      config,
      identity,
      command: exportCommand(),
      now: NOW + 1000,
      buildBundle,
    }),
    error => error instanceof ProductionAdminExportError
      && error.code === 'PRODUCTION_EXPORT_REQUEST_STALE'
      && error.status === 409,
  );
});

test('正式摘要和下载使用production issuer、公共Store及安全响应头', async () => {
  let summaryStore = null;
  const summary = await handleProductionAdminExportSummaryRequest({
    env: env(),
    request: request('/api/admin/exports/summary'),
  }, {
    now: () => NOW,
    createStore: name => { summaryStore = name; return new MemoryStore(); },
    buildSummary: async () => ({
      schemaVersion: 1,
      publicVersion: 7,
      packageId: fakeBundle(7).packageId,
      filename: fakeBundle(7).filename,
      byteLength: 5,
      fileCount: 15,
      recordCount: 6,
      tombstoneCount: 1,
      ordinaryEventCount: 3,
      sensitiveEventCount: 4,
      countsByType: fakeBundle(7).countsByType,
      generatedAt: new Date(NOW).toISOString(),
    }),
  });
  assert.equal(summary.status, 200);
  assert.equal(summaryStore, 'cloud-collab-production-v1');
  const summaryBody = await summary.json();
  assert.equal(summaryBody.data.viewer.username, 'xiaxue');
  assert.equal(summaryBody.data.capabilities.privateCredentialsIncluded, false);

  const download = await handleProductionAdminExportDownloadRequest({
    env: env(),
    request: request('/api/admin/exports/download', {
      method: 'POST',
      body: exportCommand(),
    }),
  }, {
    now: () => NOW,
    createStore: () => new MemoryStore(),
    createDownload: async () => ({ ...fakeBundle(7), duplicate: false }),
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.equal(download.headers.get('x-cloud-collab-public-version'), '7');
  assert.equal(download.headers.get('x-cloud-collab-export-duplicate'), '0');
  assert.match(download.headers.get('content-disposition'), /^attachment;/u);
});

test('跨站下载在正文解析和Store创建前阻断', async () => {
  let stores = 0;
  const response = await handleProductionAdminExportDownloadRequest({
    env: env(),
    request: request('/api/admin/exports/download', {
      method: 'POST',
      body: { broken: true },
      origin: 'https://attacker.example.invalid',
    }),
  }, {
    createStore: () => { stores += 1; return new MemoryStore(); },
  });
  assert.equal(response.status, 403);
  assert.equal(stores, 0);
});

test('生产项目导出关闭时不得回退阶段5F预览导出', async () => {
  const closed = env({
    CLOUD_PRODUCTION_EXPORT_ENABLED: '0',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
  });
  let stores = 0;
  const response = await handleAdminExportSummaryByMode({
    env: {
      ...closed,
      CLOUD_ADMIN_PREVIEW_ENABLED: '1',
      CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED: '1',
      CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-admin-preview-v1',
      CLOUD_ADMIN_EXPORT_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
      CLOUD_ADMIN_EXPORT_ALLOWED_GROUP_ID: 'group_fixture',
      CLOUD_ADMIN_EXPORT_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    },
    request: new Request(`${ADMIN_ORIGIN}/api/admin/exports/summary`, { method: 'GET' }),
  }, {
    createStore: () => { stores += 1; return new MemoryStore(); },
  });
  assert.equal(response.status, 503);
  assert.equal(stores, 0);
});

test('两条Cloud Function入口只依赖导出模式分发器', () => {
  for (const [relative, handler] of [
    ['cloud-functions/api/admin/exports/summary.js', 'handleAdminExportSummaryRequest'],
    ['cloud-functions/api/admin/exports/download.js', 'handleAdminExportDownloadRequest'],
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /admin_export_mode_dispatch_v1/u);
    assert.match(source, new RegExp(handler, 'u'));
    assert.doesNotMatch(source, /from ['"][^'"]*admin_export_http_v1/u);
  }
});

test('正式导出静态边界包含6种类型、墓碑、production issuer和独立开关', () => {
  const runtime = fs.readFileSync(path.join(root, 'src/server/production_runtime_config_v1.js'), 'utf8');
  const bundle = fs.readFileSync(path.join(root, 'src/server/production_admin_export_bundle_v1.js'), 'utf8');
  const http = fs.readFileSync(path.join(root, 'src/server/production_admin_export_http_v1.js'), 'utf8');
  const dispatch = fs.readFileSync(path.join(root, 'src/server/admin_export_mode_dispatch_v1.js'), 'utf8');
  assert.match(runtime, /CLOUD_PRODUCTION_EXPORT_ENABLED/u);
  for (const type of ['exact_price', 'playable_name', 'boss_profile', 'rank_range_rule', 'surcharge_rule', 'gift_rule']) {
    assert.match(bundle, new RegExp(type, 'u'));
  }
  assert.match(bundle, /tombstones\/index\.json/u);
  assert.match(bundle, /ordinary-public-events\.json/u);
  assert.match(bundle, /sensitive-public-events\.json/u);
  assert.match(http, /verifyProductionAdminSessionToken/u);
  assert.match(http, /runtime\.flags\.export/u);
  assert.doesNotMatch(http, /readAdminAuthConfig|verifyAdminSessionToken/u);
  assert.match(dispatch, /resolveAdminAuthMode/u);
  assert.doesNotMatch(dispatch, /CLOUD_PRODUCTION_EXPORT_ENABLED/u);
});
