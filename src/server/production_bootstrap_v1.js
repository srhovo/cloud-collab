import { createHash } from 'node:crypto';

import {
  BlobRepositoryError,
  getJSONStrong,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import { canonicalize } from './submission_policy_v1.js';
import {
  PRODUCTION_BOOTSTRAP_CONFIRMATION,
  ProductionRuntimeConfigError,
  readProductionRuntimeConfig,
} from './production_runtime_config_v1.js';

export const PRODUCTION_BOOTSTRAP_VERSION = 1;

export class ProductionBootstrapError extends Error {
  constructor(code, message, details = null, cause = null) {
    super(message || code || '生产空库初始化失败');
    this.name = 'ProductionBootstrapError';
    this.code = code || 'PRODUCTION_BOOTSTRAP_ERROR';
    this.status = 503;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function sha256(value) {
  return createHash('sha256').update(Buffer.from(canonicalize(value), 'utf8')).digest('hex');
}

function assertStore(store, role) {
  if (!store || typeof store.get !== 'function' || typeof store.setJSON !== 'function') {
    throw new ProductionBootstrapError('PRODUCTION_BOOTSTRAP_STORE_INVALID', `${role} Store缺少get或setJSON能力`);
  }
  return store;
}

function sameValue(left, right) {
  try { return canonicalize(left) === canonicalize(right); }
  catch (_) { return false; }
}

function freezeEntry(storeRole, key, value) {
  return Object.freeze({ storeRole, key, value: Object.freeze(value), sha256: sha256(value) });
}

export function buildProductionBootstrapResources(config) {
  if (!config || config.mode !== 'bootstrap' || config.flags?.bootstrap !== true) {
    throw new ProductionBootstrapError('PRODUCTION_BOOTSTRAP_MODE_REQUIRED', '必须使用通过校验的bootstrap模式配置');
  }
  if (config.bootstrapConfirmation !== PRODUCTION_BOOTSTRAP_CONFIRMATION) {
    throw new ProductionBootstrapError('PRODUCTION_BOOTSTRAP_CONFIRMATION_INVALID', '一次性初始化确认词无效');
  }

  const { groupId, libraryId } = config.scope.protocol;
  const external = config.scope.external;
  const scope = Object.freeze({ groupId, libraryId });
  const common = Object.freeze({ schemaVersion: 1, bootstrapVersion: PRODUCTION_BOOTSTRAP_VERSION });
  const publicEntries = [
    freezeEntry('public', `production/v1/groups/${groupId}.json`, {
      ...common,
      kind: 'group_metadata',
      groupId,
      externalClubId: external.clubId,
      active: true,
    }),
    freezeEntry('public', `production/v1/libraries/${libraryId}.json`, {
      ...common,
      kind: 'library_metadata',
      ...scope,
      externalLibraryId: external.libraryId,
      active: true,
    }),
    freezeEntry('public', `production/v1/public/${libraryId}/version.json`, {
      ...common,
      kind: 'public_version_pointer',
      ...scope,
      publicVersion: 0,
      snapshotVersion: 0,
    }),
    freezeEntry('public', `production/v1/public/${libraryId}/snapshots/0.json`, {
      ...common,
      kind: 'cloud_collab_public_snapshot',
      scope,
      publicVersion: 0,
      records: [],
      tombstones: [],
      generatedAt: null,
    }),
    freezeEntry('public', `production/v1/queues/${libraryId}/ordinary.json`, {
      ...common,
      kind: 'ordinary_submission_queue_marker',
      ...scope,
      pendingCount: 0,
      initialized: true,
    }),
    freezeEntry('public', `production/v1/queues/${libraryId}/sensitive.json`, {
      ...common,
      kind: 'sensitive_review_queue_marker',
      ...scope,
      pendingCount: 0,
      initialized: true,
    }),
    freezeEntry('public', `production/v1/maintenance/${libraryId}/daily-snapshot.json`, {
      ...common,
      kind: 'daily_snapshot_marker',
      ...scope,
      lastCompletedPublicVersion: null,
      lastCompletedAt: null,
    }),
    freezeEntry('public', `production/v1/maintenance/${libraryId}/migration-export.json`, {
      ...common,
      kind: 'migration_export_marker',
      ...scope,
      lastCompletedPublicVersion: null,
      lastCompletedAt: null,
    }),
  ];

  const resourceDigest = sha256(publicEntries.map(({ storeRole, key, sha256: digest }) => ({ storeRole, key, sha256: digest })));
  const adminEntries = [
    freezeEntry('admin', 'production/v1/admin/bootstrap.json', {
      ...common,
      kind: 'administrator_security_bootstrap',
      administrator: config.adminUsername,
      publicStoreName: config.publicStoreName,
      adminStoreName: config.adminStoreName,
      scope,
      resourceDigest,
      initialized: true,
    }),
    freezeEntry('admin', 'production/v1/audit/genesis.json', {
      ...common,
      kind: 'immutable_audit_genesis',
      action: 'production_bootstrap',
      actor: 'system',
      scope,
      resourceDigest,
      publicMutationAllowed: false,
      stablePromotionAuthorized: false,
    }),
  ];

  const entries = Object.freeze([...publicEntries, ...adminEntries]);
  const manifest = Object.freeze({
    schemaVersion: 1,
    kind: 'production_bootstrap_manifest',
    bootstrapVersion: PRODUCTION_BOOTSTRAP_VERSION,
    externalScope: Object.freeze({ ...external }),
    protocolScope: Object.freeze({ ...scope }),
    publicStoreName: config.publicStoreName,
    adminStoreName: config.adminStoreName,
    confirmation: PRODUCTION_BOOTSTRAP_CONFIRMATION,
    resourceDigest,
    resources: Object.freeze(entries.map(entry => Object.freeze({
      storeRole: entry.storeRole,
      key: entry.key,
      sha256: entry.sha256,
    }))),
    productionCapabilitiesEnabled: false,
    stablePromotionAuthorized: false,
  });
  return Object.freeze({ entries, manifest, manifestSha256: sha256(manifest) });
}

async function preflightEntry(store, entry) {
  const existing = await getJSONStrong(store, entry.key);
  if (existing === null || existing === undefined) return Object.freeze({ state: 'missing', entry });
  if (!sameValue(existing, entry.value)) {
    throw new ProductionBootstrapError(
      'PRODUCTION_BOOTSTRAP_EXISTING_OBJECT_CONFLICT',
      '初始化目标已存在但内容与冻结基线不一致',
      { storeRole: entry.storeRole, key: entry.key, expectedSha256: entry.sha256, actualSha256: sha256(existing) },
    );
  }
  return Object.freeze({ state: 'existing_exact', entry });
}

async function writeMissingEntry(store, entry) {
  try {
    await putJSONOnlyIfNew(store, entry.key, entry.value);
    return 'created';
  } catch (error) {
    if (!(error instanceof BlobRepositoryError) || error.code !== 'BLOB_ALREADY_EXISTS') {
      throw new ProductionBootstrapError(
        'PRODUCTION_BOOTSTRAP_WRITE_FAILED',
        '初始化对象不可变写入失败',
        { storeRole: entry.storeRole, key: entry.key },
        error,
      );
    }
    const raced = await getJSONStrong(store, entry.key);
    if (!sameValue(raced, entry.value)) {
      throw new ProductionBootstrapError(
        'PRODUCTION_BOOTSTRAP_WRITE_CONFLICT',
        '初始化对象被并发写入不同内容',
        { storeRole: entry.storeRole, key: entry.key },
        error,
      );
    }
    return 'existing_exact';
  }
}

export async function executeProductionBootstrap({
  publicStore,
  adminStore,
  env,
} = {}) {
  let config;
  try { config = readProductionRuntimeConfig(env); }
  catch (error) {
    if (error instanceof ProductionRuntimeConfigError) {
      throw new ProductionBootstrapError(error.code, error.message, error.details, error);
    }
    throw error;
  }
  const stores = Object.freeze({
    public: assertStore(publicStore, '公共生产'),
    admin: assertStore(adminStore, '管理员生产'),
  });
  const plan = buildProductionBootstrapResources(config);

  const preflight = [];
  for (const entry of plan.entries) {
    preflight.push(await preflightEntry(stores[entry.storeRole], entry));
  }

  let createdCount = 0;
  let existingExactCount = 0;
  for (const item of preflight) {
    if (item.state === 'existing_exact') {
      existingExactCount += 1;
      continue;
    }
    const result = await writeMissingEntry(stores[item.entry.storeRole], item.entry);
    if (result === 'created') createdCount += 1;
    else existingExactCount += 1;
  }

  for (const entry of plan.entries) {
    const value = await getJSONStrong(stores[entry.storeRole], entry.key);
    if (!sameValue(value, entry.value)) {
      throw new ProductionBootstrapError(
        'PRODUCTION_BOOTSTRAP_POST_VERIFY_FAILED',
        '初始化完成后强一致复核失败',
        { storeRole: entry.storeRole, key: entry.key },
      );
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    status: createdCount > 0 ? 'initialized' : 'already_initialized_exact',
    manifest: plan.manifest,
    manifestSha256: plan.manifestSha256,
    resourceCount: plan.entries.length,
    createdCount,
    existingExactCount,
    realBlobReadsPerformed: plan.entries.length * 2,
    realBlobWritesPerformed: createdCount,
    realBlobDeletesPerformed: 0,
    productionCapabilitiesEnabled: false,
    stablePromotionAuthorized: false,
  });
}
