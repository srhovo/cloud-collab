import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleSensitivePublicChangesRequest,
  handleSensitivePublicSnapshotRequest,
  handleSensitivePublicVersionRequest,
  readSensitivePublicReadConfig,
} from '../src/server/sensitive_public_http_v1.js';

const KEY = 'K'.repeat(32);
const ENV = Object.freeze({
  CLOUD_WRITE_PREVIEW_ENABLED: '1',
  CLOUD_WRITE_PREVIEW_KEY: KEY,
  CLOUD_RATE_LIMIT_SALT: 'S'.repeat(32),
  CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED: '1',
  CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED: '1',
  CLOUD_SENSITIVE_REVIEW_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_SENSITIVE_REVIEW_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_SENSITIVE_REVIEW_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
});

function request(path, { method = 'GET', key = KEY } = {}) {
  return new Request(`https://preview.example${path}`, {
    method,
    headers: key === null ? {} : { 'X-Cloud-Collab-Preview-Key': key },
  });
}

function context(path, options = {}) {
  return { request: request(path, options), env: { ...ENV } };
}

async function body(response) {
  return JSON.parse(await response.text());
}

function snapshot() {
  return Object.freeze({
    schemaVersion: 2,
    payloadSchemaVersion: 1,
    groupId: 'group_fixture',
    libraryId: 'lib_receive_fixture',
    baseOrdinaryVersion: 3,
    publicVersion: 8,
    snapshotVersion: 8,
    cursor: 'pv_8',
    generatedAt: '2026-07-20T06:40:00.000Z',
    records: Object.freeze([
      { businessKey: `bk_v1_${'A'.repeat(43)}`, contentHash: `ch_v1_${'A'.repeat(43)}`, dataType: 'exact_price', operation: 'upsert', approvedVersion: 1, payload: { serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 10 } },
      { businessKey: `bk_v1_${'B'.repeat(43)}`, contentHash: `ch_v1_${'B'.repeat(43)}`, dataType: 'playable_name', operation: 'upsert', approvedVersion: 2, payload: { name: '陪玩甲' } },
      { businessKey: `bk_v1_${'C'.repeat(43)}`, contentHash: `ch_v1_${'C'.repeat(43)}`, dataType: 'boss_profile', operation: 'upsert', approvedVersion: 3, bossId: `boss_v1_${'C'.repeat(43)}`, payload: { bossName: '老板甲', paiDan: '直属甲', discount: 0.95 } },
      { businessKey: `bk_v1_${'D'.repeat(43)}`, contentHash: `ch_v1_${'D'.repeat(43)}`, dataType: 'rank_range_rule', operation: 'upsert', approvedVersion: 4, payload: {} },
      { businessKey: `bk_v1_${'E'.repeat(43)}`, contentHash: `ch_v1_${'E'.repeat(43)}`, dataType: 'surcharge_rule', operation: 'upsert', approvedVersion: 5, payload: {} },
      { businessKey: `bk_v1_${'F'.repeat(43)}`, contentHash: `ch_v1_${'F'.repeat(43)}`, dataType: 'gift_rule', operation: 'upsert', approvedVersion: 6, payload: {} },
    ]),
    tombstones: Object.freeze([
      { businessKey: `bk_v1_${'G'.repeat(43)}`, contentHash: `ch_v1_${'G'.repeat(43)}`, dataType: 'gift_rule', operation: 'delete', approvedVersion: 7, deletedAt: '2026-07-20T06:39:00.000Z' },
      { businessKey: `bk_v1_${'H'.repeat(43)}`, contentHash: `ch_v1_${'H'.repeat(43)}`, dataType: 'boss_profile', operation: 'delete', approvedVersion: 8, deletedAt: '2026-07-20T06:40:00.000Z', bossId: `boss_v1_${'H'.repeat(43)}` },
    ]),
  });
}

const dependencies = Object.freeze({
  createStore: () => ({ synthetic: true }),
  buildSnapshot: async () => snapshot(),
  listEvents: async () => Object.freeze([
    { version: 1, approvedAt: '2026-07-20T06:31:00.000Z', businessKey: `bk_v1_${'A'.repeat(43)}`, contentHash: `ch_v1_${'A'.repeat(43)}`, dataType: 'exact_price', operation: 'upsert', payload: { serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 10 } },
    { version: 7, approvedAt: '2026-07-20T06:39:00.000Z', businessKey: `bk_v1_${'G'.repeat(43)}`, contentHash: `ch_v1_${'G'.repeat(43)}`, dataType: 'gift_rule', operation: 'delete', payload: null, bossId: null },
    { version: 8, approvedAt: '2026-07-20T06:40:00.000Z', businessKey: `bk_v1_${'H'.repeat(43)}`, contentHash: `ch_v1_${'H'.repeat(43)}`, dataType: 'boss_profile', operation: 'delete', payload: null, bossId: `boss_v1_${'H'.repeat(43)}` },
  ]),
  now: () => 1_784_526_000_000,
});

test('Stage6B敏感公共读取配置必须与隔离写入和敏感审核使用同一作用域', () => {
  const config = readSensitivePublicReadConfig({ ...ENV });
  assert.equal(config.storeName, 'cloud-collab-preview-v1');
  assert.equal(config.groupId, 'group_fixture');
  assert.equal(config.libraryId, 'lib_receive_fixture');

  assert.throws(
    () => readSensitivePublicReadConfig({ ...ENV, CLOUD_SENSITIVE_REVIEW_ALLOWED_LIBRARY_ID: 'lib_other' }),
    error => error.code === 'ADMIN_SENSITIVE_REVIEW_SCOPE_INVALID' || error.code === 'SENSITIVE_PUBLIC_SCOPE_INVALID',
  );
});

test('Stage6B版本接口返回六类记录和墓碑计数且保持正式写入关闭', async () => {
  const response = await handleSensitivePublicVersionRequest(
    context('/api/preview/sensitive-public-version?groupId=group_fixture&libraryId=lib_receive_fixture'),
    dependencies,
  );
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.publicVersion, 8);
  assert.equal(payload.data.baseOrdinaryVersion, 3);
  assert.deepEqual(payload.data.recordCounts, {
    exactPrice: 1,
    playableName: 1,
    bossProfile: 1,
    rankRangeRule: 1,
    surchargeRule: 1,
    giftRule: 1,
  });
  assert.equal(payload.data.tombstoneCounts.giftRule, 1);
  assert.equal(payload.data.tombstoneCounts.bossProfile, 1);
  assert.equal(payload.data.publicMutationAllowed, false);
  assert.equal(payload.data.autoApprovalEnabled, false);
  assert.equal(payload.data.sensitiveChangesRequireManualReview, true);
});

test('Stage6B快照接口支持ifVersion并不会重复返回完整快照', async () => {
  const response = await handleSensitivePublicSnapshotRequest(
    context('/api/preview/sensitive-public-snapshot?groupId=group_fixture&libraryId=lib_receive_fixture&ifVersion=8'),
    dependencies,
  );
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.equal(payload.data.status, 'not_modified');
  assert.equal(payload.data.snapshot, null);
  assert.equal(payload.data.publicVersion, 8);
});

test('Stage6B增量接口按版本投影upsert与墓碑并支持分页', async () => {
  const response = await handleSensitivePublicChangesRequest(
    context('/api/preview/sensitive-public-changes?groupId=group_fixture&libraryId=lib_receive_fixture&sinceVersion=1&limit=1'),
    dependencies,
  );
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.equal(payload.data.status, 'changes');
  assert.equal(payload.data.publicVersion, 8);
  assert.equal(payload.data.nextVersion, 7);
  assert.equal(payload.data.hasMore, true);
  assert.equal(payload.data.changes.length, 1);
  assert.equal(payload.data.changes[0].dataType, 'gift_rule');
  assert.equal(payload.data.changes[0].operation, 'delete');
  assert.equal(payload.data.changes[0].payload, null);
});

test('Stage6B读取在访问密钥和作用域校验完成前不会创建Blob Store', async () => {
  let stores = 0;
  const guarded = { ...dependencies, createStore: () => { stores += 1; return {}; } };
  const missing = await handleSensitivePublicVersionRequest(
    context('/api/preview/sensitive-public-version?groupId=group_fixture&libraryId=lib_receive_fixture', { key: null }),
    guarded,
  );
  assert.equal(missing.status, 403);
  assert.equal(stores, 0);

  const wrongScope = await handleSensitivePublicVersionRequest(
    context('/api/preview/sensitive-public-version?groupId=group_fixture&libraryId=lib_other'),
    guarded,
  );
  assert.equal(wrongScope.status, 403);
  assert.equal(stores, 0);
});

test('Stage6B读取拒绝多余查询参数、越界版本和错误方法', async () => {
  const extra = await handleSensitivePublicSnapshotRequest(
    context('/api/preview/sensitive-public-snapshot?groupId=group_fixture&libraryId=lib_receive_fixture&debug=1'),
    dependencies,
  );
  assert.equal(extra.status, 400);
  assert.equal((await body(extra)).error.code, 'SENSITIVE_PUBLIC_QUERY_INVALID');

  const ahead = await handleSensitivePublicChangesRequest(
    context('/api/preview/sensitive-public-changes?groupId=group_fixture&libraryId=lib_receive_fixture&sinceVersion=9'),
    dependencies,
  );
  assert.equal(ahead.status, 409);
  assert.equal((await body(ahead)).error.code, 'PUBLIC_VERSION_AHEAD');

  const method = await handleSensitivePublicVersionRequest(
    context('/api/preview/sensitive-public-version?groupId=group_fixture&libraryId=lib_receive_fixture', { method: 'POST' }),
    dependencies,
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET, HEAD, OPTIONS');

  const options = await handleSensitivePublicVersionRequest(
    context('/api/preview/sensitive-public-version', { method: 'OPTIONS' }),
    dependencies,
  );
  assert.equal(options.status, 204);
});
