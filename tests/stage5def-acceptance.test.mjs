import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAdminExportDownload,
} from '../src/server/admin_export_v1.js';
import {
  executeAdminRollback,
  listAdminRollbackCandidates,
} from '../src/server/admin_rollback_v1.js';
import {
  mutateDeviceGovernance,
} from '../src/server/device_governance_v1.js';
import {
  STAGE5DEF_FIRST_PRICE,
  STAGE5DEF_SECOND_PRICE,
  STAGE5DEF_SEED_TIME,
  checkStage5defDeviceAuthentication,
  inspectStage5defAcceptance,
  isStage5defAcceptanceProjectionSafe,
  readStage5defAcceptanceConfig,
  seedStage5defAcceptance,
} from '../src/server/stage5def_acceptance_v1.js';

const ENV = Object.freeze({
  CLOUD_STAGE5DEF_ACCEPTANCE_ENABLED: '1',
  CLOUD_STAGE5DEF_CLEANUP_ENABLED: '0',
  CLOUD_STAGE5DEF_ACCEPTANCE_KEY: 'stage5def-acceptance-key-0123456789012345',
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '0',
  CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://stage5def-admin.test',
  CLOUD_ADMIN_USERNAME: 'stage5def-admin@example.test',
  CLOUD_ADMIN_PASSWORD: 'stage5def-password-0123456789',
  CLOUD_ADMIN_SESSION_SECRET: 'stage5def-session-secret-012345678901234',
  CLOUD_ADMIN_RATE_LIMIT_SALT: 'stage5def-admin-rate-salt-012345678901',
  CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-admin-preview-v1',
  CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_DEVICE_GOVERNANCE_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_DEVICE_REF_SALT: 'stage5def-device-ref-salt-0123456789012',
  CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_ROLLBACK_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_ROLLBACK_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_ADMIN_ROLLBACK_REF_SALT: 'stage5def-rollback-ref-salt-01234567890',
  CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_EXPORT_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_EXPORT_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_ADMIN_EXPORT_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_ADMIN_EXPORT_AUDIT_SALT: 'stage5def-export-audit-salt-012345678901',
});

const IDENTITY = Object.freeze({
  username: 'stage5def-admin@example.test',
  sessionIdSuffix: 'DEF1',
  expiresAt: STAGE5DEF_SEED_TIME + 900_000,
});

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

function governanceInput(deviceRef, requestSuffix, reasonCode) {
  return {
    schemaVersion: 1,
    deviceRef,
    requestId: `dgrq_v1_${requestSuffix.padEnd(22, 'A')}`,
    reasonCode,
  };
}

test('Stage5DEF config is default closed, mutually exclusive, fixture locked, and secret separated', () => {
  assert.throws(
    () => readStage5defAcceptanceConfig({}),
    error => error.code === 'STAGE5DEF_ACCEPTANCE_DISABLED',
  );
  assert.throws(
    () => readStage5defAcceptanceConfig({ ...ENV, CLOUD_STAGE5DEF_CLEANUP_ENABLED: '1' }),
    error => error.code === 'STAGE5DEF_ACCEPTANCE_CLEANUP_CONFLICT',
  );
  assert.throws(
    () => readStage5defAcceptanceConfig({ ...ENV, CLOUD_ADMIN_EXPORT_BLOB_STORE_NAME: 'formal-store' }),
    error => error.code === 'STAGE5DEF_ACCEPTANCE_CONFIG_INVALID',
  );
  assert.throws(
    () => readStage5defAcceptanceConfig({ ...ENV, CLOUD_STAGE5DEF_ACCEPTANCE_KEY: ENV.CLOUD_ADMIN_SESSION_SECRET }),
    error => error.code === 'STAGE5DEF_ACCEPTANCE_SECRETS_REUSED',
  );
  const config = readStage5defAcceptanceConfig(ENV);
  assert.equal(config.publicStoreName, 'cloud-collab-preview-v1');
  assert.equal(config.adminStoreName, 'cloud-collab-admin-preview-v1');
});

test('Stage5DEF seed is idempotent and full governance rollback export flow becomes cleanup-ready', async () => {
  const store = new MemoryBlobStore();
  const config = readStage5defAcceptanceConfig(ENV);
  const seeded = await seedStage5defAcceptance({ store, config });
  assert.equal(seeded.publicVersion, 2);
  assert.equal(seeded.currentUnitPrice, STAGE5DEF_SECOND_PRICE);
  assert.equal(seeded.devices.length, 2);
  assert.equal(isStage5defAcceptanceProjectionSafe(seeded), true);
  const refs = Object.fromEntries(seeded.devices.map(item => [item.slot, item.deviceRef]));

  await mutateDeviceGovernance({
    store,
    config: config.governanceConfig,
    identity: IDENTITY,
    command: { action: 'trust', input: governanceInput(refs.A, 'TRUST', 'verified_operator') },
    now: STAGE5DEF_SEED_TIME + 10_000,
  });
  await mutateDeviceGovernance({
    store,
    config: config.governanceConfig,
    identity: IDENTITY,
    command: { action: 'revoke_trust', input: governanceInput(refs.A, 'REVOKE', 'trust_withdrawn') },
    now: STAGE5DEF_SEED_TIME + 11_000,
  });
  await mutateDeviceGovernance({
    store,
    config: config.governanceConfig,
    identity: IDENTITY,
    command: { action: 'block', input: governanceInput(refs.B, 'BLOCK', 'manual_safety') },
    now: STAGE5DEF_SEED_TIME + 12_000,
  });
  await assert.rejects(
    () => checkStage5defDeviceAuthentication({
      store,
      config,
      slot: 'B',
      now: STAGE5DEF_SEED_TIME + 12_500,
    }),
    error => error.code === 'DEVICE_BLOCKED' && error.status === 403,
  );
  await mutateDeviceGovernance({
    store,
    config: config.governanceConfig,
    identity: IDENTITY,
    command: { action: 'unblock', input: governanceInput(refs.B, 'UNBLOCK', 'manual_review_cleared') },
    now: STAGE5DEF_SEED_TIME + 13_000,
  });
  const authenticated = await checkStage5defDeviceAuthentication({
    store,
    config,
    slot: 'B',
    now: STAGE5DEF_SEED_TIME + 13_500,
  });
  assert.equal(authenticated.authenticated, true);

  const candidates = await listAdminRollbackCandidates({ store, config: config.rollbackConfig });
  assert.equal(candidates.count, 1);
  assert.equal(candidates.candidates[0].currentUnitPrice, STAGE5DEF_SECOND_PRICE);
  assert.equal(candidates.candidates[0].previousUnitPrice, STAGE5DEF_FIRST_PRICE);
  const rollbackCommand = {
    schemaVersion: 1,
    rollbackRef: candidates.candidates[0].rollbackRef,
    requestId: `rbrq_v1_${'ROLLBACK'.padEnd(22, 'A')}`,
    confirmation: 'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE',
  };
  const rollback = await executeAdminRollback({
    store,
    config: config.rollbackConfig,
    identity: IDENTITY,
    command: rollbackCommand,
    now: STAGE5DEF_SEED_TIME + 20_000,
  });
  assert.equal(rollback.publicVersion, 3);
  assert.equal(rollback.restoredUnitPrice, STAGE5DEF_FIRST_PRICE);
  const rollbackReplay = await executeAdminRollback({
    store,
    config: config.rollbackConfig,
    identity: IDENTITY,
    command: rollbackCommand,
    now: STAGE5DEF_SEED_TIME + 21_000,
  });
  assert.equal(rollbackReplay.duplicate, true);
  assert.equal(rollbackReplay.publicVersion, 3);

  const exportCommand = {
    schemaVersion: 1,
    requestId: `exrq_v1_${'EXPORT'.padEnd(22, 'A')}`,
    confirmation: 'EXPORT_SYNTHETIC_PUBLIC_DATABASE',
  };
  const exported = await createAdminExportDownload({
    store,
    config: config.exportConfig,
    identity: IDENTITY,
    command: exportCommand,
    now: STAGE5DEF_SEED_TIME + 30_000,
  });
  assert.equal(exported.publicVersion, 3);
  assert.equal(exported.contentType, 'application/zip');
  assert.equal(exported.bytes[0], 0x50);
  assert.equal(exported.bytes[1], 0x4b);
  const exportReplay = await createAdminExportDownload({
    store,
    config: config.exportConfig,
    identity: IDENTITY,
    command: exportCommand,
    now: STAGE5DEF_SEED_TIME + 31_000,
  });
  assert.equal(exportReplay.duplicate, true);
  assert.equal(exportReplay.packageId, exported.packageId);
  assert.deepEqual(exportReplay.bytes, exported.bytes);

  const status = await inspectStage5defAcceptance({
    store,
    config,
    now: STAGE5DEF_SEED_TIME + 40_000,
  });
  assert.equal(status.publicVersion, 3);
  assert.equal(status.currentUnitPrice, STAGE5DEF_FIRST_PRICE);
  assert.equal(status.governanceComplete, true);
  assert.equal(status.rollbackComplete, true);
  assert.equal(status.exportComplete, true);
  assert.equal(status.readyForCleanup, true);
  assert.equal(status.audits.governance, 4);
  assert.equal(status.audits.rollback, 1);
  assert.equal(status.audits.export, 1);
  assert.equal(isStage5defAcceptanceProjectionSafe(status), true);

  const reseeded = await seedStage5defAcceptance({ store, config });
  assert.equal(reseeded.publicVersion, 3);
  assert.equal(reseeded.currentUnitPrice, STAGE5DEF_FIRST_PRICE);
  assert.equal([...store.values.keys()].filter(key => key.startsWith('public/lib_receive_fixture/events/')).length, 3);
  assert.equal(store.listCalls.every(call => call.consistency === 'strong'), true);
});
