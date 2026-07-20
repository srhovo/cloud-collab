import { buildMaintenanceIntegrityReport } from './maintenance_integrity_v1.js';
import { buildDailyMaintenancePlan } from './maintenance_daily_plan_v1.js';
import {
  buildDailySnapshotArtifact,
  buildMaintenanceMigrationBundle,
} from './maintenance_migration_bundle_v1.js';
import { buildUnifiedSensitivePublicSnapshot } from './sensitive_public_engine_v1.js';

export const MAINTENANCE_EXECUTION_VERSION = 1;
export const MAINTENANCE_EXECUTION_MODE_PLAN_ONLY = 'plan_only';
export const MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS = 'build_due_artifacts';

const EXECUTION_MODES = new Set([
  MAINTENANCE_EXECUTION_MODE_PLAN_ONLY,
  MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS,
]);
const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const PACKAGE_ID_PATTERN = /^mpkg_v1_[A-Za-z0-9_-]{43}$/;
const MAX_VERSION = 999_999_999_999;

export class MaintenanceExecutionError extends Error {
  constructor(code, message, status = 500, details = null, cause = null) {
    super(message || code || '维护执行失败');
    this.name = 'MaintenanceExecutionError';
    this.code = code || 'MAINTENANCE_EXECUTION_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeId(value, pattern, code, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!pattern.test(text)) throw new MaintenanceExecutionError(code, `${label}格式无效`, 400);
  return text;
}

function normalizeScope(groupId, libraryId) {
  return Object.freeze({
    groupId: normalizeId(groupId, GROUP_ID_PATTERN, 'MAINTENANCE_EXECUTION_GROUP_INVALID', 'groupId'),
    libraryId: normalizeId(libraryId, LIBRARY_ID_PATTERN, 'MAINTENANCE_EXECUTION_LIBRARY_INVALID', 'libraryId'),
  });
}

function assertNow(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new MaintenanceExecutionError('MAINTENANCE_EXECUTION_TIME_INVALID', '维护执行时间无效', 400);
  }
  return value;
}

function normalizeMode(value) {
  const mode = String(value || MAINTENANCE_EXECUTION_MODE_PLAN_ONLY).trim().toLowerCase();
  if (!EXECUTION_MODES.has(mode)) {
    throw new MaintenanceExecutionError('MAINTENANCE_EXECUTION_MODE_INVALID', '维护执行模式无效', 400, {
      mode,
      allowedModes: [...EXECUTION_MODES],
    });
  }
  return mode;
}

function assertVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VERSION) {
    throw new MaintenanceExecutionError('MAINTENANCE_EXECUTION_VERSION_INVALID', `${label}无效`, 500, { value });
  }
  return value;
}

function assertScope(value, scope, code, label) {
  if (!isPlainObject(value)
      || value.groupId !== scope.groupId
      || value.libraryId !== scope.libraryId) {
    throw new MaintenanceExecutionError(code, `${label}作用域不一致`, 409);
  }
  return value;
}

function validateIntegrityReport(report, scope) {
  if (!isPlainObject(report) || report.schemaVersion !== 1
      || report.readOnly !== true || report.mutationsPerformed !== 0
      || !isPlainObject(report.public) || !isPlainObject(report.checks)
      || Object.keys(report.checks).length === 0
      || Object.values(report.checks).some(value => value !== true)) {
    throw new MaintenanceExecutionError(
      'MAINTENANCE_EXECUTION_INTEGRITY_INVALID',
      '阶段7A完整性报告无效或未全绿',
      409,
    );
  }
  assertScope(report.scope, scope, 'MAINTENANCE_EXECUTION_INTEGRITY_SCOPE_MISMATCH', '完整性报告');
  const ordinaryVersion = assertVersion(report.public.ordinaryVersion, '普通公共版本');
  const publicVersion = assertVersion(report.public.publicVersion, '统一公共版本');
  const snapshotVersion = assertVersion(report.public.snapshotVersion, '统一快照版本');
  if (ordinaryVersion > publicVersion || snapshotVersion !== publicVersion) {
    throw new MaintenanceExecutionError(
      'MAINTENANCE_EXECUTION_INTEGRITY_VERSION_MISMATCH',
      '完整性报告公共版本不一致',
      409,
      { ordinaryVersion, publicVersion, snapshotVersion },
    );
  }
  return Object.freeze({ ordinaryVersion, publicVersion, snapshotVersion });
}

function validatePlan(plan, scope, publicVersion) {
  if (!isPlainObject(plan) || plan.schemaVersion !== 1
      || plan.readOnly !== true || plan.mutationsPerformed !== 0
      || !isPlainObject(plan.tasks) || !Array.isArray(plan.actions)) {
    throw new MaintenanceExecutionError('MAINTENANCE_EXECUTION_PLAN_INVALID', '阶段7B维护计划结构无效', 409);
  }
  assertScope(plan.scope, scope, 'MAINTENANCE_EXECUTION_PLAN_SCOPE_MISMATCH', '维护计划');
  if (plan.currentPublicVersion !== publicVersion) {
    throw new MaintenanceExecutionError(
      'MAINTENANCE_EXECUTION_PLAN_VERSION_MISMATCH',
      '维护计划与完整性报告公共版本不一致',
      409,
      { planVersion: plan.currentPublicVersion, publicVersion },
    );
  }
  if (!isPlainObject(plan.tasks.snapshot) || typeof plan.tasks.snapshot.due !== 'boolean'
      || !isPlainObject(plan.tasks.migrationExport) || typeof plan.tasks.migrationExport.due !== 'boolean'
      || !isPlainObject(plan.tasks.candidates)) {
    throw new MaintenanceExecutionError('MAINTENANCE_EXECUTION_PLAN_INVALID', '维护计划任务结构无效', 409);
  }
  return plan;
}

function assertBuffer(value, code, label) {
  if (!Buffer.isBuffer(value) || value.length < 1) {
    throw new MaintenanceExecutionError(code, `${label}字节无效`, 500);
  }
  return value;
}

function validateSnapshotArtifact(artifact, scope, publicVersion) {
  if (!isPlainObject(artifact) || artifact.schemaVersion !== 1
      || artifact.readOnly !== true || artifact.mutationsPerformed !== 0
      || artifact.publicVersion !== publicVersion || artifact.snapshotVersion !== publicVersion
      || !SHA256_HEX_PATTERN.test(String(artifact.sha256 || ''))
      || !isPlainObject(artifact.marker)) {
    throw new MaintenanceExecutionError(
      'MAINTENANCE_EXECUTION_SNAPSHOT_ARTIFACT_INVALID',
      '每日快照工件结构或版本无效',
      409,
    );
  }
  assertScope(artifact.scope, scope, 'MAINTENANCE_EXECUTION_SNAPSHOT_SCOPE_MISMATCH', '每日快照工件');
  const bytes = assertBuffer(
    artifact.bytes,
    'MAINTENANCE_EXECUTION_SNAPSHOT_BYTES_INVALID',
    '每日快照工件',
  );
  if (artifact.byteLength !== bytes.length
      || artifact.marker.publicVersion !== publicVersion
      || artifact.marker.artifactSha256 !== artifact.sha256
      || !Number.isFinite(Date.parse(String(artifact.marker.completedAt || '')))) {
    throw new MaintenanceExecutionError(
      'MAINTENANCE_EXECUTION_SNAPSHOT_ARTIFACT_INVALID',
      '每日快照工件摘要或标记无效',
      409,
    );
  }
  return artifact;
}

function validateMigrationBundle(bundle, scope, publicVersion) {
  if (!isPlainObject(bundle) || bundle.schemaVersion !== 1
      || bundle.readOnly !== true || bundle.mutationsPerformed !== 0
      || bundle.publicVersion !== publicVersion || bundle.snapshotVersion !== publicVersion
      || !PACKAGE_ID_PATTERN.test(String(bundle.packageId || ''))
      || !SHA256_HEX_PATTERN.test(String(bundle.packageSha256 || ''))
      || !isPlainObject(bundle.dailySnapshot) || !isPlainObject(bundle.marker)) {
    throw new MaintenanceExecutionError(
      'MAINTENANCE_EXECUTION_MIGRATION_ARTIFACT_INVALID',
      '迁移导出包结构或版本无效',
      409,
    );
  }
  assertScope(bundle.scope, scope, 'MAINTENANCE_EXECUTION_MIGRATION_SCOPE_MISMATCH', '迁移导出包');
  const bytes = assertBuffer(
    bundle.bytes,
    'MAINTENANCE_EXECUTION_MIGRATION_BYTES_INVALID',
    '迁移导出包',
  );
  if (bundle.byteLength !== bytes.length
      || !SHA256_HEX_PATTERN.test(String(bundle.dailySnapshot.sha256 || ''))
      || bundle.marker.publicVersion !== publicVersion
      || bundle.marker.packageId !== bundle.packageId
      || bundle.marker.packageSha256 !== bundle.packageSha256
      || !Number.isFinite(Date.parse(String(bundle.marker.completedAt || '')))) {
    throw new MaintenanceExecutionError(
      'MAINTENANCE_EXECUTION_MIGRATION_ARTIFACT_INVALID',
      '迁移导出包摘要、内嵌快照或标记无效',
      409,
    );
  }
  return bundle;
}

function artifactMetadataSnapshot(artifact) {
  return Object.freeze({
    publicVersion: artifact.publicVersion,
    snapshotVersion: artifact.snapshotVersion,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    marker: artifact.marker,
    bytes: artifact.bytes,
  });
}

function artifactMetadataMigration(bundle) {
  return Object.freeze({
    packageId: bundle.packageId,
    publicVersion: bundle.publicVersion,
    ordinaryVersion: bundle.ordinaryVersion,
    snapshotVersion: bundle.snapshotVersion,
    recordCount: bundle.recordCount,
    tombstoneCount: bundle.tombstoneCount,
    ordinaryEventCount: bundle.ordinaryEventCount,
    sensitiveEventCount: bundle.sensitiveEventCount,
    filename: bundle.filename,
    contentType: bundle.contentType,
    byteLength: bundle.byteLength,
    fileCount: bundle.fileCount,
    packageSha256: bundle.packageSha256,
    marker: bundle.marker,
    embeddedSnapshot: bundle.dailySnapshot,
    bytes: bundle.bytes,
  });
}

function actionTypes(plan) {
  return new Set(plan.actions.map(action => String(action?.type || '')));
}

function executionStatus({ plan, mode, artifactsBuilt }) {
  if (plan.status === 'attention_required') return 'attention_required';
  if (mode === MAINTENANCE_EXECUTION_MODE_PLAN_ONLY) return 'planned';
  if (artifactsBuilt > 0) return 'artifacts_built';
  return 'up_to_date';
}

function wrapFailure(error, code, message) {
  if (error instanceof MaintenanceExecutionError) throw error;
  throw new MaintenanceExecutionError(code, message, error?.status || 503, null, error);
}

export async function runMaintenanceExecution({
  store,
  groupId,
  libraryId,
  lastDailySnapshot = null,
  lastMigrationExport = null,
  thresholds = {},
  mode = MAINTENANCE_EXECUTION_MODE_PLAN_ONLY,
  now = Date.now(),
  dependencies = {},
} = {}) {
  const executedAtMs = assertNow(now);
  const scope = normalizeScope(groupId, libraryId);
  const executionMode = normalizeMode(mode);
  const buildIntegrity = dependencies.buildIntegrityReport || buildMaintenanceIntegrityReport;
  const buildPlan = dependencies.buildDailyPlan || buildDailyMaintenancePlan;
  const buildSnapshot = dependencies.buildSnapshot || buildUnifiedSensitivePublicSnapshot;
  const buildSnapshotArtifact = dependencies.buildSnapshotArtifact || buildDailySnapshotArtifact;
  const buildMigration = dependencies.buildMigrationBundle || buildMaintenanceMigrationBundle;

  let integrityReport;
  try {
    integrityReport = await buildIntegrity({
      store,
      groupId: scope.groupId,
      libraryId: scope.libraryId,
      now: executedAtMs,
    });
  } catch (error) {
    wrapFailure(error, 'MAINTENANCE_EXECUTION_INTEGRITY_FAILED', '维护执行前完整性核查失败');
  }
  const versions = validateIntegrityReport(integrityReport, scope);

  let plan;
  try {
    plan = await buildPlan({
      integrityReport,
      lastDailySnapshot,
      lastMigrationExport,
      thresholds,
      now: executedAtMs,
    });
  } catch (error) {
    wrapFailure(error, 'MAINTENANCE_EXECUTION_PLAN_FAILED', '维护执行计划生成失败');
  }
  validatePlan(plan, scope, versions.publicVersion);

  const plannedActionTypes = actionTypes(plan);
  const snapshotDue = plan.tasks.snapshot.due === true
    && plannedActionTypes.has('rebuild_daily_snapshot');
  const migrationDue = plan.tasks.migrationExport.due === true
    && plannedActionTypes.has('generate_migration_export');
  const buildArtifacts = executionMode === MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS;
  let snapshotArtifact = null;
  let migrationBundle = null;

  if (buildArtifacts && snapshotDue) {
    let snapshot;
    try {
      snapshot = await buildSnapshot({
        store,
        groupId: scope.groupId,
        libraryId: scope.libraryId,
        now: executedAtMs,
      });
      snapshotArtifact = await buildSnapshotArtifact({
        integrityReport,
        snapshot,
        now: executedAtMs,
      });
    } catch (error) {
      wrapFailure(error, 'MAINTENANCE_EXECUTION_SNAPSHOT_BUILD_FAILED', '每日快照工件生成失败');
    }
    validateSnapshotArtifact(snapshotArtifact, scope, versions.publicVersion);
  }

  if (buildArtifacts && migrationDue) {
    try {
      migrationBundle = await buildMigration({
        store,
        groupId: scope.groupId,
        libraryId: scope.libraryId,
        now: executedAtMs,
        dependencies: {
          buildIntegrityReport: async () => integrityReport,
        },
      });
    } catch (error) {
      wrapFailure(error, 'MAINTENANCE_EXECUTION_MIGRATION_BUILD_FAILED', '迁移导出包生成失败');
    }
    validateMigrationBundle(migrationBundle, scope, versions.publicVersion);
  }

  if (snapshotArtifact && migrationBundle
      && snapshotArtifact.sha256 !== migrationBundle.dailySnapshot.sha256) {
    throw new MaintenanceExecutionError(
      'MAINTENANCE_EXECUTION_SOURCE_DRIFT',
      '每日快照与迁移包内嵌快照不一致，公共数据可能在执行期间发生变化',
      409,
      {
        snapshotSha256: snapshotArtifact.sha256,
        embeddedSnapshotSha256: migrationBundle.dailySnapshot.sha256,
      },
    );
  }

  const artifacts = Object.freeze({
    dailySnapshot: snapshotArtifact ? artifactMetadataSnapshot(snapshotArtifact) : null,
    migrationExport: migrationBundle ? artifactMetadataMigration(migrationBundle) : null,
  });
  const markers = Object.freeze({
    dailySnapshot: snapshotArtifact ? snapshotArtifact.marker : null,
    migrationExport: migrationBundle ? migrationBundle.marker : null,
  });
  const builtActions = Object.freeze([
    ...(snapshotArtifact ? ['rebuild_daily_snapshot'] : []),
    ...(migrationBundle ? ['generate_migration_export'] : []),
  ]);
  const deferredActions = Object.freeze(plan.actions
    .map(action => String(action?.type || ''))
    .filter(type => type && !builtActions.includes(type)));
  const artifactsBuilt = builtActions.length;

  return Object.freeze({
    schemaVersion: MAINTENANCE_EXECUTION_VERSION,
    scope,
    executedAt: new Date(executedAtMs).toISOString(),
    mode: executionMode,
    status: executionStatus({ plan, mode: executionMode, artifactsBuilt }),
    publicVersionLock: versions.publicVersion,
    readOnlySource: true,
    mutationsPerformed: 0,
    automaticPersistenceAllowed: false,
    integrityReport,
    plan,
    execution: Object.freeze({
      artifactBuildRequested: buildArtifacts,
      snapshotDue,
      migrationExportDue: migrationDue,
      builtActions,
      deferredActions,
      artifactsBuilt,
    }),
    artifacts,
    proposedMarkers: markers,
  });
}
