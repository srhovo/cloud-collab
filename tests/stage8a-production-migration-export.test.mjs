import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdminSessionCookie } from '../src/server/admin_auth_v1.js';
import {
  handleAdminExportDownloadByMode,
  handleAdminExportSummaryByMode,
} from '../src/server/admin_export_mode_dispatch_v1.js';
import {
  createProductionAdminSessionToken,
  readProductionAdminAuthConfig,
} from '../src/server/production_admin_auth_v1.js';
import {
  PRODUCTION_EXPORT_CONFIRMATION,
  buildProductionMigrationExportBundle,
  buildProductionMigrationExportSummary,
  isProductionExportProjectionSafe,
} from '../src/server/production_admin_export_v1.js';
import { createProductionMigrationExportDownloadV1 } from '../src/server/production_admin_export_download_v1.js';
import {
  handleProductionAdminExportDownloadRequest,
  handleProductionAdminExportSummaryRequest,
  readProductionAdminExportConfig,
} from '../src/server/production_admin_export_http_v1.js';
import { readProductionRuntimeConfig } from '../src/server/production_runtime_config_v1.js';
import { crc32 } from '../src/server/zip_store_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_640_000_000;

const SECRETS = Object.freeze({
  password: 'stage8a-admin-password-0000000000000000000001',
  client: 'stage8a-client-key-0000000000000000000000002',
  publicRate: 'stage8a-public-rate-000000000000000000000003',
  session: 'stage8a-session-secret-00000000000000000000004',
  adminRate: 'stage8a-admin-rate-000000000000000000000005',
  device: 'stage8a-device-ref-000000000000000000000006',
  rollback: 'stage8a-rollback-ref-00000000000000000000007',
  audit: 'stage8a-export-audit-000000000000000000000008',
});

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

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.listCalls = [];
  }

  clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
  }

  async get(key) {
    return this.values.has(key) ? this.clone(this.values.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.values.set(key, this.clone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list(options = {}) {
    this.listCalls.push(this.clone(options));
    const prefix = String(options.prefix || '');
    return {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
}

function id(prefix, character) {
  return `${prefix}${character.repeat(43)}`;
}

function snapshot(publicVersion = 7) {
  const records = [
    {
      businessKey: id('bk_v1_', 'A'),
      contentHash: id('ch_v1_', 'A'),
      dataType: 'exact_price',
      operation: 'upsert',
      approvedVersion: 1,
      payload: { serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 100 },
    },
    {
      businessKey: id('bk_v1_', 'B'),
      contentHash: id('ch_v1_', 'B'),
      dataType: 'playable_name',
      operation: 'upsert',
      approvedVersion: 2,
      payload: { name: '下雪' },
    },
    {
      businessKey: id('bk_v1_', 'C'),
      contentHash: id('ch_v1_', 'C'),
      dataType: 'boss_profile',
      operation: 'upsert',
      approvedVersion: 3,
      bossId: id('boss_v1_', 'C'),
      payload: { bossName: '老板甲', paiDan: '直属甲', discount: 0.8 },
    },
    {
      businessKey: id('bk_v1_', 'D'),
      contentHash: id('ch_v1_', 'D'),
      dataType: 'rank_range_rule',
      operation: 'upsert',
      approvedVersion: 4,
      payload: {
        rangeLabel: '青铜至白银', alias: '低段', rankType: 'stars',
        minStar: 0, maxStar: 20, namedRanks: [], prices: { round: 10 },
      },
    },
    {
      businessKey: id('bk_v1_', 'E'),
      contentHash: id('ch_v1_', 'E'),
      dataType: 'surcharge_rule',
      operation: 'upsert',
      approvedVersion: 5,
      payload: { name: '夜间加价', keywords: ['夜间'], prices: { round: 5 }, enabled: true },
    },
    {
      businessKey: id('bk_v1_', 'F'),
      contentHash: id('ch_v1_', 'F'),
      dataType: 'gift_rule',
      operation: 'upsert',
      approvedVersion: 6,
      payload: { serviceName: '礼物', mode: 'fixed', unitPrice: 20 },
    },
  ];
  const tombstones = [{
    businessKey: id('bk_v1_', 'G'),
    contentHash: id('ch_v1_', 'G'),
    dataType: 'exact_price',
    operation: 'delete',
    approvedVersion: 7,
    deletedAt: new Date(NOW + 7000).toISOString(),
  }];
  return {
    schemaVersion: 2,
    payloadSchemaVersion: 1,
    groupId: 'group_see',
    libraryId: 'lib_see_cz',
    baseOrdinaryVersion: 3,
    publicVersion,
    snapshotVersion: publicVersion,
    cursor: `pv_${publicVersion}`,
    generatedAt: new Date(NOW + publicVersion * 1000).toISOString(),
    records,
    tombstones,
  };
}

function snapshotBuilder(versionRef) {
  return async () => snapshot(versionRef.value);
}

function parseStoredZip(bytes) {
  const buffer = Buffer.from(bytes);
  const files = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(flags & 0x0800, 0x0800);
    assert.equal(method, 0);
    assert.equal(compressedSize, uncompressedSize);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    assert.equal(crc32(data), expectedCrc);
    files.set(name, Buffer.from(data));
    offset = dataStart + compressedSize;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  return files;
}

function sessionCookie(runtimeEnv = env()) {
  const config = readProductionAdminAuthConfig(runtimeEnv);
  const session = createProductionAdminSessionToken({
    config,
    now: NOW,
    randomBytes: length => Buffer.alloc(length, 8),
  });
  return createAdminSessionCookie(session.token).split(';')[0];
}

function request(pathname, {
  method = 'GET',
  body = null,
  origin = method === 'POST' ? 'https://admin.example.invalid' : null,
  cookie = sessionCookie(),
} = {}) {
  const headers = new Headers({ 'Sec-Fetch-Site': 'same-origin' });
  if (origin) headers.set('Origin', origin);
  if (cookie) headers.set('Cookie', cookie);
  if (body !== null) headers.set('Content-Type', 'application/json');
  return new Request(`https://admin.example.invalid${pathname}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
}

function downloadCommand(label = 'DOWNLOAD') {
  return {
    schemaVersion: 1,
    requestId: `exrq_v1_${label.padEnd(22, 'A')}`,
    confirmation: PRODUCTION_EXPORT_CONFIRMATION,
  };
}

function bundleBuilder(versionRef) {
  return options => buildProductionMigrationExportBundle({
    ...options,
    buildSnapshot: snapshotBuilder(versionRef),
  });
}

test('正式迁移导出使用独立开关且不依赖人工审核或写入能力', () => {
  const runtime = readProductionRuntimeConfig(env());
  assert.equal(runtime.flags.migrationExport, true);
  assert.equal(runtime.flags.adminReview, false);
  assert.equal(runtime.flags.ordinarySubmission, false);
  assert.equal(runtime.flags.sensitiveSubmission, false);

  const config = readProductionAdminExportConfig(env());
  assert.equal(config.mode, 'production');
  assert.equal(config.storeName, 'cloud-collab-production-v1');
  assert.equal(config.groupId, 'group_see');
  assert.equal(config.libraryId, 'lib_see_cz');
  assert.deepEqual(config.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.equal(config.stablePromotionAuthorized, false);

  assert.throws(
    () => readProductionAdminExportConfig(env({ CLOUD_PRODUCTION_EXPORT_ENABLED: '0' })),
    error => error.code === 'PRODUCTION_EXPORT_DISABLED',
  );
  assert.throws(
    () => readProductionRuntimeConfig(env({ CLOUD_ADMIN_PRODUCTION_ENABLED: '0' })),
    error => error.code === 'PRODUCTION_ROLLOUT_ORDER_INVALID',
  );
});

test('完整迁移ZIP覆盖六类数据、墓碑、稳定摘要且不含私密身份', async () => {
  const config = readProductionAdminExportConfig(env());
  const bundle = await buildProductionMigrationExportBundle({
    store: new MemoryBlobStore(),
    config,
    now: NOW + 10_000,
    buildSnapshot: async () => snapshot(),
  });
  assert.equal(bundle.publicVersion, 7);
  assert.equal(bundle.recordCount, 6);
  assert.equal(bundle.tombstoneCount, 1);
  assert.equal(bundle.fileCount, 10);
  assert.match(bundle.packageId, /^pkg_v2_[A-Za-z0-9_-]{43}$/u);
  assert.equal(bundle.contentType, 'application/zip');

  const files = parseStoredZip(bundle.bytes);
  const expected = [
    '码单器公共数据库迁移包/manifest.json',
    '码单器公共数据库迁移包/schema.json',
    '码单器公共数据库迁移包/groups.json',
    '码单器公共数据库迁移包/libraries/lib_see_cz.json',
    '码单器公共数据库迁移包/prices/index.json',
    '码单器公共数据库迁移包/playable-names/index.json',
    '码单器公共数据库迁移包/bosses/index.json',
    '码单器公共数据库迁移包/rules/index.json',
    '码单器公共数据库迁移包/tombstones/index.json',
    '码单器公共数据库迁移包/audit/export-summary.json',
  ];
  assert.deepEqual([...files.keys()].sort(), expected.sort());

  const manifest = JSON.parse(files.get('码单器公共数据库迁移包/manifest.json').toString('utf8'));
  assert.equal(manifest.packageFormatVersion, 2);
  assert.equal(manifest.packageId, bundle.packageId);
  assert.equal(manifest.publicVersion, 7);
  assert.equal(manifest.recordCount, 6);
  assert.equal(manifest.tombstoneCount, 1);
  assert.equal(manifest.sectionCounts.exact_price, 1);
  assert.equal(manifest.sectionCounts.playable_name, 1);
  assert.equal(manifest.sectionCounts.boss_profile, 1);
  assert.equal(manifest.sectionCounts.rank_range_rule, 1);
  assert.equal(manifest.sectionCounts.surcharge_rule, 1);
  assert.equal(manifest.sectionCounts.gift_rule, 1);
  assert.equal(manifest.files.length, 9);
  for (const descriptor of manifest.files) {
    const data = files.get(`码单器公共数据库迁移包/${descriptor.name}`);
    assert.ok(data, descriptor.name);
    assert.equal(data.length, descriptor.byteLength);
    assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
  }

  const library = JSON.parse(files.get('码单器公共数据库迁移包/libraries/lib_see_cz.json').toString('utf8'));
  assert.equal(library.records.length, 6);
  assert.equal(library.tombstones.length, 1);
  const text = bundle.bytes.toString('utf8');
  for (const forbidden of ['deviceToken', 'tokenHash', 'submissionId', 'idempotencyKey', 'cloud-collab-production-v1']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.equal(isProductionExportProjectionSafe(manifest), true);
});

test('正式摘要端点使用production issuer和公共生产Blob', async () => {
  let storeName = null;
  const response = await handleProductionAdminExportSummaryRequest({
    env: env(),
    request: request('/api/admin/exports/summary'),
  }, {
    now: () => NOW + 11_000,
    createStore: name => { storeName = name; return new MemoryBlobStore(); },
    buildSnapshot: async () => snapshot(),
  });
  assert.equal(response.status, 200);
  assert.equal(storeName, 'cloud-collab-production-v1');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'production');
  assert.equal(body.data.viewer.username, 'xiaxue');
  assert.equal(body.data.result.packageFormatVersion, 2);
  assert.equal(body.data.result.recordCount, 6);
  assert.equal(body.data.result.tombstoneCount, 1);
  assert.equal(body.data.result.portableWithoutEdgeOne, true);
  assert.equal(body.data.capabilities.publicMutationAllowed, false);
  assert.equal(body.data.realSecretValuesExposed, false);
  assert.equal(body.data.stablePromotionAuthorized, false);
});

test('同一正式下载请求跨时间精确重放相同ZIP且不产生第二份审计', async () => {
  const store = new MemoryBlobStore();
  const config = readProductionAdminExportConfig(env());
  const versionRef = { value: 7 };
  const options = {
    store,
    config,
    identity: { username: 'xiaxue' },
    command: downloadCommand('REPLAY'),
    buildBundle: bundleBuilder(versionRef),
  };
  const first = await createProductionMigrationExportDownloadV1({ ...options, now: NOW + 20_000 });
  const replay = await createProductionMigrationExportDownloadV1({ ...options, now: NOW + 90_000 });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(first.packageId, replay.packageId);
  assert.equal(first.byteLength, replay.byteLength);
  assert.equal(Buffer.compare(first.bytes, replay.bytes), 0);
  assert.equal(first.requestFirstCreatedAt, NOW + 20_000);
  assert.equal(replay.requestFirstCreatedAt, NOW + 20_000);
  assert.equal([...store.values.keys()].filter(key => key.includes('production-requests/')).length, 1);
  assert.equal([...store.values.keys()].filter(key => key.includes('production-decisions/')).length, 1);
  assert.equal([...store.values.keys()].filter(key => key.startsWith('audit/')).length, 1);
});

test('同一requestId冻结公共版本，版本变化时要求新的requestId', async () => {
  const store = new MemoryBlobStore();
  const config = readProductionAdminExportConfig(env());
  const versionRef = { value: 7 };
  const options = {
    store,
    config,
    identity: { username: 'xiaxue' },
    command: downloadCommand('MOVED'),
    buildBundle: bundleBuilder(versionRef),
  };
  await createProductionMigrationExportDownloadV1({ ...options, now: NOW + 30_000 });
  versionRef.value = 8;
  await assert.rejects(
    () => createProductionMigrationExportDownloadV1({ ...options, now: NOW + 31_000 }),
    error => error.code === 'PRODUCTION_EXPORT_BASE_MOVED' && error.status === 409,
  );
  assert.equal([...store.values.keys()].filter(key => key.startsWith('audit/')).length, 1);
});

test('正式下载HTTP返回ZIP证据头并阻断跨站正文与Store访问', async () => {
  const store = new MemoryBlobStore();
  const versionRef = { value: 7 };
  const response = await handleProductionAdminExportDownloadRequest({
    env: env(),
    request: request('/api/admin/exports/download', {
      method: 'POST',
      body: downloadCommand('HTTP'),
    }),
  }, {
    now: () => NOW + 40_000,
    createStore: () => store,
    buildBundle: bundleBuilder(versionRef),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('x-mdq-package-format'), '2');
  assert.equal(response.headers.get('x-mdq-public-version'), '7');
  assert.equal(response.headers.get('x-mdq-record-count'), '6');
  assert.equal(response.headers.get('x-mdq-tombstone-count'), '1');
  assert.equal(response.headers.get('x-mdq-stable-promotion-authorized'), '0');
  assert.equal((await response.arrayBuffer()).byteLength > 0, true);

  let bodyReads = 0;
  let storeCreates = 0;
  const original = request('/api/admin/exports/download', {
    method: 'POST',
    origin: 'https://evil.example.invalid',
    body: {},
  });
  const wrapped = {
    method: original.method,
    url: original.url,
    headers: original.headers,
    text: async () => { bodyReads += 1; return '{}'; },
  };
  const rejected = await handleProductionAdminExportDownloadRequest({ env: env(), request: wrapped }, {
    now: () => NOW,
    createStore: () => { storeCreates += 1; return new MemoryBlobStore(); },
  });
  assert.equal(rejected.status, 403);
  assert.equal(bodyReads, 0);
  assert.equal(storeCreates, 0);
});

test('生产总开关决定导出模式，导出子开关关闭不回退预览', async () => {
  let previewCalls = 0;
  let storeCreates = 0;
  const disabledEnv = env({ CLOUD_PRODUCTION_EXPORT_ENABLED: '0' });
  const response = await handleAdminExportSummaryByMode({
    env: disabledEnv,
    request: request('/api/admin/exports/summary', { cookie: sessionCookie(disabledEnv) }),
  }, {
    production: {
      now: () => NOW,
      createStore: () => { storeCreates += 1; return new MemoryBlobStore(); },
    },
    preview: {
      buildSummary: async () => { previewCalls += 1; return {}; },
    },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PRODUCTION_EXPORT_DISABLED');
  assert.equal(previewCalls, 0);
  assert.equal(storeCreates, 0);

  const invalid = await handleAdminExportSummaryByMode({
    env: env({ CLOUD_PRODUCTION_ENABLED: 'invalid' }),
    request: request('/api/admin/exports/summary'),
  });
  assert.equal(invalid.status, 503);
  assert.equal((await invalid.json()).error.code, 'PRODUCTION_FLAG_INVALID');
});

test('两个导出Cloud Function入口只依赖模式分发器并保留阶段5F处理器名', () => {
  const files = [
    ['cloud-functions/api/admin/exports/summary.js', 'handleAdminExportSummaryRequest'],
    ['cloud-functions/api/admin/exports/download.js', 'handleAdminExportDownloadRequest'],
  ];
  for (const [filename, legacyName] of files) {
    const source = fs.readFileSync(path.join(root, filename), 'utf8');
    assert.match(source, /admin_export_mode_dispatch_v1/u);
    assert.match(source, new RegExp(legacyName, 'u'));
    assert.doesNotMatch(source, /from ['"][^'"]*admin_export_http_v1\.js['"]/u);
  }
});

test('生产模板默认关闭迁移导出且仓库没有导入已移除的旧下载实现', () => {
  const template = fs.readFileSync(path.join(root, 'config/production.env.template'), 'utf8');
  assert.match(template, /^CLOUD_PRODUCTION_EXPORT_ENABLED=0$/mu);
  assert.doesNotMatch(template, /^CLOUD_PRODUCTION_EXPORT_ENABLED=1$/mu);

  const productionHttp = fs.readFileSync(path.join(root, 'src/server/production_admin_export_http_v1.js'), 'utf8');
  assert.match(productionHttp, /createProductionMigrationExportDownloadV1/u);
  assert.doesNotMatch(productionHttp, /createProductionMigrationExportDownload[^V]/u);

  const bundleCore = fs.readFileSync(path.join(root, 'src/server/production_admin_export_v1.js'), 'utf8');
  assert.doesNotMatch(bundleCore, /BlobRepositoryError|putJSONOnlyIfNew|production-requests/u);
});
