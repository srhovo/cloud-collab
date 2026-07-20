import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STAGE5G6A6B_CLEANUP_CONFIRMATION,
  cleanupStage5g6a6bObjects,
  inspectStage5g6a6bObjects,
  readStage5g6a6bCleanupConfig,
} from '../src/server/stage5g6a6b_cleanup_v1.js';

class MemoryStore {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  async list() { return { blobs: [...this.values.keys()].sort().map(key => ({ key })) }; }
  async delete(key) { this.values.delete(key); }
}

function env(overrides = {}) {
  return {
    CLOUD_STAGE5G6A6B_CLEANUP_ENABLED: '1',
    CLOUD_STAGE5G6A6B_CLEANUP_CONFIRMATION: STAGE5G6A6B_CLEANUP_CONFIRMATION,
    CLOUD_STAGE5G6A6B_CLEANUP_KEY: 'cleanup-key-'.padEnd(40, 'a'),
    CLOUD_STAGE5G6A6B_ACCEPTANCE_ENABLED: '0',
    CLOUD_WRITE_PREVIEW_ENABLED: '0',
    CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
    CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED: '0',
    CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED: '0',
    CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED: '0',
    CLOUD_ADMIN_PREVIEW_ENABLED: '0',
    CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '0',
    CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '0',
    CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-admin-preview-v1',
    CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://acceptance.example.test',
    CLOUD_STAGE5G6A6B_ACCEPTANCE_KEY: 'acceptance-key-'.padEnd(40, 'b'),
    CLOUD_WRITE_PREVIEW_KEY: 'preview-key-'.padEnd(40, 'c'),
    CLOUD_RATE_LIMIT_SALT: 'rate-salt-'.padEnd(40, 'd'),
    CLOUD_ADMIN_PASSWORD: 'admin-password-'.padEnd(40, 'e'),
    CLOUD_ADMIN_SESSION_SECRET: 'admin-session-'.padEnd(40, 'f'),
    CLOUD_ADMIN_RATE_LIMIT_SALT: 'admin-rate-'.padEnd(40, 'g'),
    ...overrides,
  };
}

test('清理配置要求所有能力关闭且密钥独立', () => {
  const config = readStage5g6a6bCleanupConfig(env());
  assert.equal(config.publicStoreName, 'cloud-collab-preview-v1');
  assert.throws(
    () => readStage5g6a6bCleanupConfig(env({ CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED: '1' })),
    error => error.code === 'STAGE5G6A6B_CLEANUP_REQUIRES_ALL_CAPABILITIES_CLOSED',
  );
  assert.throws(
    () => readStage5g6a6bCleanupConfig(env({
      CLOUD_STAGE5G6A6B_CLEANUP_KEY: 'same-secret-'.padEnd(40, 'x'),
      CLOUD_STAGE5G6A6B_ACCEPTANCE_KEY: 'same-secret-'.padEnd(40, 'x'),
    })),
    error => error.code === 'STAGE5G6A6B_CLEANUP_KEY_REUSED',
  );
});

test('检查只接受固定白名单对象并返回摘要', async () => {
  const publicStore = new MemoryStore({
    'stage5g6a6b/seed/v1.json': {},
    'devices/profiles/dev_01JSTAGE5G6A6B000000000001.json': {},
    'submissions/lib_receive_fixture/pending/ik_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json': {},
    'public/lib_receive_fixture/events/000000000001.json': {},
  });
  const adminStore = new MemoryStore({
    'admin-preview-rate/login/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/1.json': {},
  });
  const result = await inspectStage5g6a6bObjects({ publicStore, adminStore });
  assert.equal(result.publicObjectCount, 4);
  assert.equal(result.adminObjectCount, 1);
  assert.match(result.publicKeySetDigest, /^[A-Za-z0-9_-]{43}$/);
});

test('未知对象在删除前失败关闭', async () => {
  const publicStore = new MemoryStore({ 'real-production/object.json': {} });
  const adminStore = new MemoryStore();
  await assert.rejects(
    inspectStage5g6a6bObjects({ publicStore, adminStore }),
    error => error.code === 'STAGE5G6A6B_CLEANUP_UNSAFE_OBJECTS',
  );
  assert.equal(publicStore.values.size, 1);
});

test('删除绑定检查摘要并在完成后强一致验证双Blob为零', async () => {
  const publicStore = new MemoryStore({
    'stage5g6a6b/seed/v1.json': {},
    'reviews/lib_receive_fixture/sensitive-decisions/srv_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json': {},
  });
  const adminStore = new MemoryStore({
    'admin-preview-rate/login/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/1.json': {},
  });
  const inspected = await inspectStage5g6a6bObjects({ publicStore, adminStore });
  await assert.rejects(
    cleanupStage5g6a6bObjects({
      publicStore,
      adminStore,
      expectedPublicKeySetDigest: 'B'.repeat(43),
      expectedAdminKeySetDigest: inspected.adminKeySetDigest,
    }),
    error => error.code === 'STAGE5G6A6B_CLEANUP_KEYSET_CHANGED',
  );
  const result = await cleanupStage5g6a6bObjects({
    publicStore,
    adminStore,
    expectedPublicKeySetDigest: inspected.publicKeySetDigest,
    expectedAdminKeySetDigest: inspected.adminKeySetDigest,
  });
  assert.equal(result.totalObjectCount, 0);
  assert.equal(result.strongConsistencyVerified, true);
  assert.equal(publicStore.values.size, 0);
  assert.equal(adminStore.values.size, 0);
});
