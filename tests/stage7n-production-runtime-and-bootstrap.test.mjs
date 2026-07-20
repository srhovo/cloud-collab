import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRODUCTION_BOOTSTRAP_CONFIRMATION,
  ProductionRuntimeConfigError,
  projectProductionRuntimeStatus,
  readProductionRuntimeConfig,
} from '../src/server/production_runtime_config_v1.js';
import {
  ProductionBootstrapError,
  buildProductionBootstrapResources,
  executeProductionBootstrap,
} from '../src/server/production_bootstrap_v1.js';

function baseEnv(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '0',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '0',
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
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: '',
    CLOUD_ADMIN_PUBLIC_ORIGIN: '',
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: '',
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: '',
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_SESSION_SECRET: '',
    CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_DEVICE_REF_SALT: '',
    CLOUD_ADMIN_ROLLBACK_REF_SALT: '',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
    ...overrides,
  };
}

function secret(label) {
  return `${label}_${'x'.repeat(40)}`;
}

function enabledSecrets() {
  return {
    CLOUD_ADMIN_PASSWORD: secret('password'),
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: secret('client'),
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: secret('public_rate'),
    CLOUD_ADMIN_SESSION_SECRET: secret('session'),
    CLOUD_ADMIN_RATE_LIMIT_SALT: secret('admin_rate'),
    CLOUD_ADMIN_DEVICE_REF_SALT: secret('device'),
    CLOUD_ADMIN_ROLLBACK_REF_SALT: secret('rollback'),
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: secret('export'),
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MemoryStore {
  constructor(initial = {}) {
    this.objects = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)]));
    this.calls = { get: 0, setJSON: 0, delete: 0 };
  }

  async get(key) {
    this.calls.get += 1;
    return this.objects.has(key) ? clone(this.objects.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    this.calls.setJSON += 1;
    if (options.onlyIfNew && this.objects.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.objects.set(key, clone(value));
  }

  async delete(key) {
    this.calls.delete += 1;
    this.objects.delete(key);
  }
}

test('全部关闭配置通过且不暴露密钥', () => {
  const config = readProductionRuntimeConfig(baseEnv());
  assert.equal(config.mode, 'disabled');
  assert.equal(config.runtimeEnabled, false);
  assert.deepEqual(config.scope.external, { clubId: 'see', libraryId: 'see_cz' });
  assert.deepEqual(config.scope.protocol, { groupId: 'group_see', libraryId: 'lib_see_cz' });
  assert.equal(projectProductionRuntimeStatus(config).realSecretValuesExposed, false);
  assert.equal(projectProductionRuntimeStatus(config).stablePromotionAuthorized, false);
});

test('只读生产配置是允许的第一步', () => {
  const config = readProductionRuntimeConfig(baseEnv({
    ...enabledSecrets(),
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://example.invalid',
  }));
  assert.equal(config.mode, 'production');
  assert.equal(config.flags.readSync, true);
  assert.equal(config.flags.ordinarySubmission, false);
  assert.equal(config.publicOrigin, 'https://example.invalid');
});

test('总开关关闭时子能力不能单独开启', () => {
  assert.throws(
    () => readProductionRuntimeConfig(baseEnv({ CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1' })),
    error => error instanceof ProductionRuntimeConfigError && error.code === 'PRODUCTION_MASTER_GATE_CLOSED',
  );
});

test('分阶段依赖顺序失败关闭', () => {
  for (const overrides of [
    { CLOUD_PRODUCTION_ENABLED: '1', CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1' },
    { CLOUD_PRODUCTION_ENABLED: '1', CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1', CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1' },
    { CLOUD_PRODUCTION_ENABLED: '1', CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1', CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '1' },
  ]) {
    assert.throws(
      () => readProductionRuntimeConfig(baseEnv({ ...enabledSecrets(), CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://example.invalid', ...overrides })),
      error => error instanceof ProductionRuntimeConfigError && error.code === 'PRODUCTION_ROLLOUT_ORDER_INVALID',
    );
  }
});

test('完整授权链配置可通过但不代表稳定晋升', () => {
  const config = readProductionRuntimeConfig(baseEnv({
    ...enabledSecrets(),
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '1',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '1',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://example.invalid',
    CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://admin.example.invalid',
  }));
  assert.equal(config.flags.sensitiveSubmission, true);
  assert.equal(config.flags.adminReview, true);
  assert.equal(config.stablePromotionAuthorized, false);
});

test('弱密钥、复用密钥和错误来源被拒绝', () => {
  assert.throws(
    () => readProductionRuntimeConfig(baseEnv({
      CLOUD_PRODUCTION_ENABLED: '1',
      CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
      CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'http://example.invalid',
      CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: 'short',
      CLOUD_PRODUCTION_RATE_LIMIT_SALT: 'short',
    })),
    ProductionRuntimeConfigError,
  );
  const duplicate = secret('duplicate');
  assert.throws(
    () => readProductionRuntimeConfig(baseEnv({
      ...enabledSecrets(),
      CLOUD_PRODUCTION_ENABLED: '1',
      CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
      CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://example.invalid',
      CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: duplicate,
      CLOUD_PRODUCTION_RATE_LIMIT_SALT: duplicate,
    })),
    error => error instanceof ProductionRuntimeConfigError && error.code === 'PRODUCTION_SECRETS_MUST_BE_DISTINCT',
  );
});

test('bootstrap配置要求全部生产能力关闭和精确确认词', () => {
  assert.throws(
    () => readProductionRuntimeConfig(baseEnv({ CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '1' })),
    error => error instanceof ProductionRuntimeConfigError && error.code === 'PRODUCTION_BOOTSTRAP_CONFIRMATION_INVALID',
  );
  assert.throws(
    () => readProductionRuntimeConfig(baseEnv({
      CLOUD_PRODUCTION_ENABLED: '1',
      CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
      CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://example.invalid',
      CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '1',
      CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: PRODUCTION_BOOTSTRAP_CONFIRMATION,
      ...enabledSecrets(),
    })),
    error => error instanceof ProductionRuntimeConfigError && error.code === 'PRODUCTION_BOOTSTRAP_NOT_ISOLATED',
  );
  const config = readProductionRuntimeConfig(baseEnv({
    CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '1',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: PRODUCTION_BOOTSTRAP_CONFIRMATION,
  }));
  assert.equal(config.mode, 'bootstrap');
  assert.equal(config.flags.production, false);
});

test('首次初始化创建冻结资源且不执行删除或开启能力', async () => {
  const publicStore = new MemoryStore();
  const adminStore = new MemoryStore();
  const env = baseEnv({
    CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '1',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: PRODUCTION_BOOTSTRAP_CONFIRMATION,
  });
  const result = await executeProductionBootstrap({ publicStore, adminStore, env });
  assert.equal(result.status, 'initialized');
  assert.equal(result.resourceCount, 10);
  assert.equal(result.createdCount, 10);
  assert.equal(result.existingExactCount, 0);
  assert.equal(result.realBlobDeletesPerformed, 0);
  assert.equal(result.productionCapabilitiesEnabled, false);
  assert.equal(result.stablePromotionAuthorized, false);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.equal(publicStore.objects.size, 8);
  assert.equal(adminStore.objects.size, 2);
  assert.equal(publicStore.calls.delete + adminStore.calls.delete, 0);
});

test('精确重放不新增对象也不写入', async () => {
  const publicStore = new MemoryStore();
  const adminStore = new MemoryStore();
  const env = baseEnv({
    CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '1',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: PRODUCTION_BOOTSTRAP_CONFIRMATION,
  });
  const first = await executeProductionBootstrap({ publicStore, adminStore, env });
  const writesBefore = publicStore.calls.setJSON + adminStore.calls.setJSON;
  const second = await executeProductionBootstrap({ publicStore, adminStore, env });
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.equal(second.status, 'already_initialized_exact');
  assert.equal(second.createdCount, 0);
  assert.equal(second.existingExactCount, 10);
  assert.equal(publicStore.calls.setJSON + adminStore.calls.setJSON, writesBefore);
});

test('既有对象内容冲突时在任何新写入前失败', async () => {
  const config = readProductionRuntimeConfig(baseEnv({
    CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '1',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: PRODUCTION_BOOTSTRAP_CONFIRMATION,
  }));
  const plan = buildProductionBootstrapResources(config);
  const firstPublic = plan.entries.find(entry => entry.storeRole === 'public');
  const publicStore = new MemoryStore({ [firstPublic.key]: { tampered: true } });
  const adminStore = new MemoryStore();
  await assert.rejects(
    () => executeProductionBootstrap({ publicStore, adminStore, env: baseEnv({
      CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '1',
      CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: PRODUCTION_BOOTSTRAP_CONFIRMATION,
    }) }),
    error => error instanceof ProductionBootstrapError
      && error.code === 'PRODUCTION_BOOTSTRAP_EXISTING_OBJECT_CONFLICT',
  );
  assert.equal(publicStore.calls.setJSON, 0);
  assert.equal(adminStore.calls.setJSON, 0);
});
