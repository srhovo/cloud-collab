import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  handleProductionPublicChangesRequest,
  handleProductionPublicSnapshotRequest,
  handleProductionPublicVersionRequest,
} from '../src/server/production_read_http_v1.js';
import {
  ProductionReadRuntimeError,
  readProductionPublicEvents,
  readProductionPublicSnapshot,
  readProductionReadConfig,
  resolveProductionReadScope,
} from '../src/server/production_read_runtime_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function secret(label) {
  return `${label}_${'s'.repeat(40)}`;
}

function env(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
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
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://app.example.invalid',
    CLOUD_ADMIN_PUBLIC_ORIGIN: '',
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: '',
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: secret('client'),
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: secret('rate'),
    CLOUD_ADMIN_SESSION_SECRET: '',
    CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_DEVICE_REF_SALT: '',
    CLOUD_ADMIN_ROLLBACK_REF_SALT: '',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
    ...overrides,
  };
}

function disabledEnv() {
  const value = env();
  value.CLOUD_PRODUCTION_ENABLED = '0';
  value.CLOUD_PRODUCTION_READ_SYNC_ENABLED = '0';
  value.CLOUD_PRODUCTION_PUBLIC_ORIGIN = '';
  value.CLOUD_PRODUCTION_CLIENT_ACCESS_KEY = '';
  value.CLOUD_PRODUCTION_RATE_LIMIT_SALT = '';
  return value;
}

function request(pathname, { method = 'GET', origin = '' } = {}) {
  const headers = origin ? { Origin: origin } : {};
  return new Request(`https://app.example.invalid${pathname}`, { method, headers });
}

function context(pathname, options = {}) {
  return { request: request(pathname, options), env: options.env || env() };
}

function dummyStore() {
  return {
    async get() { return null; },
    async list() { return { blobs: [] }; },
    async setJSON() { throw new Error('read-only test must not write'); },
    async delete() { throw new Error('read-only test must not delete'); },
  };
}

function rawEvent(version, operation = 'upsert') {
  return {
    version,
    eventKey: `public/lib_see_cz/events/${String(version).padStart(12, '0')}.json`,
    groupId: 'group_see',
    libraryId: 'lib_see_cz',
    approvedAt: `2026-07-21T00:00:0${version}.000Z`,
    businessKey: `bk_${version}`,
    contentHash: `ch_${version}`,
    dataType: 'exact_price',
    operation,
    payload: operation === 'delete' ? null : { serviceName: '测试', settleType: 'round', unitPrice: 100 + version },
  };
}

test('正式只读配置只接受已授权作用域', () => {
  const config = readProductionReadConfig(env());
  assert.deepEqual(resolveProductionReadScope('see', 'see_cz', config).protocol, {
    groupId: 'group_see', libraryId: 'lib_see_cz',
  });
  assert.deepEqual(resolveProductionReadScope('group_see', 'lib_see_cz', config).external, {
    clubId: 'see', libraryId: 'see_cz',
  });
  assert.throws(
    () => resolveProductionReadScope('other', 'see_cz', config),
    error => error instanceof ProductionReadRuntimeError && error.code === 'PRODUCTION_READ_SCOPE_FORBIDDEN',
  );
});

test('生产开关关闭时路由在创建Store前返回503', async () => {
  let createCalls = 0;
  const response = await handleProductionPublicVersionRequest(
    context('/api/public/version?groupId=see&libraryId=see_cz', { env: disabledEnv() }),
    { createStore() { createCalls += 1; return dummyStore(); } },
  );
  assert.equal(response.status, 503);
  assert.equal(createCalls, 0);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'PRODUCTION_READ_SYNC_DISABLED');
});

test('空库版本响应使用用户可见ID且保持写入关闭', async () => {
  const response = await handleProductionPublicVersionRequest(
    context('/api/public/version?clubId=see&libraryId=see_cz', { origin: 'https://app.example.invalid' }),
    {
      createStore: dummyStore,
      async listEvents({ groupId, libraryId }) {
        assert.equal(groupId, 'group_see');
        assert.equal(libraryId, 'lib_see_cz');
        return [];
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.invalid');
  const body = await response.json();
  assert.equal(body.data.groupId, 'see');
  assert.equal(body.data.libraryId, 'see_cz');
  assert.deepEqual(body.data.protocolScope, { groupId: 'group_see', libraryId: 'lib_see_cz' });
  assert.equal(body.data.publicVersion, 0);
  assert.equal(body.data.status, 'production_empty');
  assert.equal(body.data.readSyncEnabled, true);
  assert.equal(body.data.ordinarySubmissionEnabled, false);
  assert.equal(body.data.stablePromotionAuthorized, false);
});

test('非匹配来源不返回通配或错误CORS授权', async () => {
  const response = await handleProductionPublicVersionRequest(
    context('/api/public/version?groupId=see&libraryId=see_cz', { origin: 'https://evil.example.invalid' }),
    { createStore: dummyStore, async listEvents() { return []; } },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
});

test('快照把协议作用域投影为用户可见作用域', async () => {
  const response = await handleProductionPublicSnapshotRequest(
    context('/api/public/snapshot?groupId=see&libraryId=see_cz&ifVersion=1'),
    {
      createStore: dummyStore,
      now: () => 1784580000000,
      async buildSnapshot({ groupId, libraryId }) {
        return {
          schemaVersion: 2,
          payloadSchemaVersion: 1,
          groupId,
          libraryId,
          baseOrdinaryVersion: 2,
          publicVersion: 2,
          snapshotVersion: 2,
          cursor: 'pv_2',
          generatedAt: '2026-07-21T00:00:02.000Z',
          records: [],
          tombstones: [],
        };
      },
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.status, 'snapshot');
  assert.equal(body.data.snapshot.groupId, 'see');
  assert.equal(body.data.snapshot.libraryId, 'see_cz');
  assert.deepEqual(body.data.snapshot.protocolScope, { groupId: 'group_see', libraryId: 'lib_see_cz' });
});

test('空快照与未修改快照均不传输正文', async () => {
  for (const [publicVersion, ifVersion, expectedStatus] of [[0, 0, 'snapshot_unavailable'], [3, 3, 'not_modified']]) {
    const response = await handleProductionPublicSnapshotRequest(
      context(`/api/public/snapshot?groupId=see&libraryId=see_cz&ifVersion=${ifVersion}`),
      {
        createStore: dummyStore,
        async buildSnapshot({ groupId, libraryId }) {
          return {
            schemaVersion: 2,
            payloadSchemaVersion: 1,
            groupId,
            libraryId,
            baseOrdinaryVersion: publicVersion,
            publicVersion,
            snapshotVersion: publicVersion,
            cursor: `pv_${publicVersion}`,
            generatedAt: 1784580000000,
            records: [],
            tombstones: [],
          };
        },
      },
    );
    const body = await response.json();
    assert.equal(body.data.status, expectedStatus);
    assert.equal(body.data.snapshot, null);
  }
});

test('增量接口分页并检测本地版本超前', async () => {
  const dependencies = {
    createStore: dummyStore,
    async listEvents() { return [rawEvent(1), rawEvent(2), rawEvent(3)]; },
  };
  const response = await handleProductionPublicChangesRequest(
    context('/api/public/changes?groupId=see&libraryId=see_cz&sinceVersion=1&limit=1'),
    dependencies,
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.changes.length, 1);
  assert.equal(body.data.changes[0].version, 2);
  assert.equal(body.data.nextVersion, 2);
  assert.equal(body.data.hasMore, true);
  assert.equal(body.data.groupId, 'see');

  const ahead = await handleProductionPublicChangesRequest(
    context('/api/public/changes?groupId=see&libraryId=see_cz&sinceVersion=4'),
    dependencies,
  );
  assert.equal(ahead.status, 409);
  const aheadBody = await ahead.json();
  assert.equal(aheadBody.error.code, 'PUBLIC_VERSION_AHEAD');
});

test('底层快照或事件作用域错误时失败关闭', async () => {
  await assert.rejects(
    () => readProductionPublicSnapshot({
      store: dummyStore(), env: env(), groupId: 'see', libraryId: 'see_cz',
      async buildSnapshot() { return { groupId: 'group_other', libraryId: 'lib_see_cz' }; },
    }),
    error => error instanceof ProductionReadRuntimeError && error.code === 'PRODUCTION_SNAPSHOT_SCOPE_MISMATCH',
  );
  await assert.rejects(
    () => readProductionPublicEvents({
      store: dummyStore(), env: env(), groupId: 'see', libraryId: 'see_cz',
      async listEvents() { return [{ ...rawEvent(1), groupId: 'group_other' }]; },
    }),
    error => error instanceof ProductionReadRuntimeError && error.code === 'PRODUCTION_EVENT_SCOPE_MISMATCH',
  );
});

test('写方法被拒绝且生产Cloud Function导入路径存在', async () => {
  const response = await handleProductionPublicVersionRequest(
    context('/api/public/version?groupId=see&libraryId=see_cz', { method: 'POST' }),
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD, OPTIONS');

  for (const file of ['version.js', 'snapshot.js', 'changes.js']) {
    const source = fs.readFileSync(path.join(root, 'cloud-functions/api/public', file), 'utf8');
    assert.match(source, /resolveCloudFunctionContext/u);
    assert.match(source, /production_read_http_v1\.js/u);
    assert.doesNotMatch(source, /preview/u);
  }
});
