import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS,
  MAINTENANCE_EXECUTION_MODE_PLAN_ONLY,
  MaintenanceExecutionError,
  runMaintenanceExecution,
} from '../src/server/maintenance_execution_v1.js';

const NOW = Date.parse('2026-07-20T17:00:00.000Z');
const GROUP_ID = 'group_fixture';
const LIBRARY_ID = 'lib_receive_fixture';
const VERSION = 7;
const SNAPSHOT_SHA = 'a'.repeat(64);
const PACKAGE_SHA = 'b'.repeat(64);
const CURRENT_MARKER = Object.freeze({
  publicVersion: VERSION,
  completedAt: new Date(NOW - 60_000).toISOString(),
});

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    scope: { groupId: GROUP_ID, libraryId: LIBRARY_ID },
    checkedAt: new Date(NOW - 1000).toISOString(),
    status: 'healthy',
    readOnly: true,
    mutationsPerformed: 0,
    public: {
      ordinaryVersion: 3,
      sensitiveEventCount: 4,
      publicVersion: VERSION,
      snapshotVersion: VERSION,
      recordCount: 5,
      tombstoneCount: 1,
      latestChangeAt: new Date(NOW - 2000).toISOString(),
    },
    inventory: {
      storedCandidateObjectCount: 0,
      invalidCandidateTimeCount: 0,
      oldestStoredCandidateAgeMs: null,
    },
    checks: {
      ordinaryEventChainValid: true,
      sensitiveEventChainValid: true,
      snapshotScopeValid: true,
      snapshotVersionValid: true,
      snapshotCursorValid: true,
      businessKeyPartitionValid: true,
      strongInventoryRead: true,
    },
    ...overrides,
  };
}

function snapshotArtifact({ sha256 = SNAPSHOT_SHA, publicVersion = VERSION } = {}) {
  const bytes = Buffer.from('snapshot-artifact', 'utf8');
  return {
    schemaVersion: 1,
    scope: { groupId: GROUP_ID, libraryId: LIBRARY_ID },
    generatedAt: new Date(NOW).toISOString(),
    publicVersion,
    snapshotVersion: publicVersion,
    byteLength: bytes.length,
    sha256,
    bytes,
    marker: {
      publicVersion,
      completedAt: new Date(NOW).toISOString(),
      artifactSha256: sha256,
    },
    readOnly: true,
    mutationsPerformed: 0,
  };
}

function migrationBundle({ snapshotSha256 = SNAPSHOT_SHA, mutationsPerformed = 0 } = {}) {
  const bytes = Buffer.from('migration-bundle', 'utf8');
  const packageId = `mpkg_v1_${'A'.repeat(43)}`;
  return {
    schemaVersion: 1,
    scope: { groupId: GROUP_ID, libraryId: LIBRARY_ID },
    packageId,
    generatedAt: new Date(NOW).toISOString(),
    publicVersion: VERSION,
    ordinaryVersion: 3,
    snapshotVersion: VERSION,
    recordCount: 5,
    tombstoneCount: 1,
    ordinaryEventCount: 3,
    sensitiveEventCount: 4,
    filename: `码单器公共数据库迁移_v${VERSION}.zip`,
    contentType: 'application/zip',
    byteLength: bytes.length,
    fileCount: 7,
    packageSha256: PACKAGE_SHA,
    bytes,
    dailySnapshot: {
      byteLength: 18,
      sha256: snapshotSha256,
      marker: {
        publicVersion: VERSION,
        completedAt: new Date(NOW).toISOString(),
        artifactSha256: snapshotSha256,
      },
    },
    marker: {
      publicVersion: VERSION,
      completedAt: new Date(NOW).toISOString(),
      packageId,
      packageSha256: PACKAGE_SHA,
    },
    readOnly: true,
    mutationsPerformed,
  };
}

function dependencies(calls = {}) {
  Object.assign(calls, { integrity: 0, snapshot: 0, artifact: 0, migration: 0 });
  return {
    buildIntegrityReport: async () => {
      calls.integrity += 1;
      return report();
    },
    buildSnapshot: async () => {
      calls.snapshot += 1;
      return { synthetic: true };
    },
    buildSnapshotArtifact: async () => {
      calls.artifact += 1;
      return snapshotArtifact();
    },
    buildMigrationBundle: async () => {
      calls.migration += 1;
      return migrationBundle();
    },
  };
}

function input(extra = {}) {
  return {
    store: {},
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    now: NOW,
    ...extra,
  };
}

test('默认plan_only只生成计划，不构建工件', async () => {
  const calls = {};
  const result = await runMaintenanceExecution(input({ dependencies: dependencies(calls) }));
  assert.equal(result.mode, MAINTENANCE_EXECUTION_MODE_PLAN_ONLY);
  assert.equal(result.status, 'planned');
  assert.equal(result.execution.snapshotDue, true);
  assert.equal(result.execution.migrationExportDue, true);
  assert.deepEqual(result.execution.builtActions, []);
  assert.deepEqual(result.execution.deferredActions, [
    'rebuild_daily_snapshot',
    'generate_migration_export',
  ]);
  assert.equal(result.artifacts.dailySnapshot, null);
  assert.equal(result.artifacts.migrationExport, null);
  assert.equal(result.automaticPersistenceAllowed, false);
  assert.equal(result.mutationsPerformed, 0);
  assert.deepEqual(calls, { integrity: 1, snapshot: 0, artifact: 0, migration: 0 });
});

test('显式模式构建两个到期工件并输出建议标记', async () => {
  const calls = {};
  const result = await runMaintenanceExecution(input({
    mode: MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS,
    dependencies: dependencies(calls),
  }));
  assert.equal(result.status, 'artifacts_built');
  assert.equal(result.publicVersionLock, VERSION);
  assert.deepEqual(result.execution.builtActions, [
    'rebuild_daily_snapshot',
    'generate_migration_export',
  ]);
  assert.equal(result.artifacts.dailySnapshot.sha256, SNAPSHOT_SHA);
  assert.equal(result.artifacts.migrationExport.packageSha256, PACKAGE_SHA);
  assert.equal(result.artifacts.migrationExport.embeddedSnapshot.sha256, SNAPSHOT_SHA);
  assert.ok(Buffer.isBuffer(result.artifacts.dailySnapshot.bytes));
  assert.ok(Buffer.isBuffer(result.artifacts.migrationExport.bytes));
  assert.equal(result.proposedMarkers.dailySnapshot.artifactSha256, SNAPSHOT_SHA);
  assert.equal(result.proposedMarkers.migrationExport.packageSha256, PACKAGE_SHA);
  assert.deepEqual(calls, { integrity: 1, snapshot: 1, artifact: 1, migration: 1 });
});

test('新鲜标记使显式模式保持零工件生成', async () => {
  const calls = {};
  const result = await runMaintenanceExecution(input({
    mode: MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS,
    lastDailySnapshot: CURRENT_MARKER,
    lastMigrationExport: CURRENT_MARKER,
    dependencies: dependencies(calls),
  }));
  assert.equal(result.status, 'up_to_date');
  assert.deepEqual(result.execution.builtActions, []);
  assert.deepEqual(calls, { integrity: 1, snapshot: 0, artifact: 0, migration: 0 });
});

test('只构建实际到期的单个工件', async () => {
  const snapshotCalls = {};
  const snapshotResult = await runMaintenanceExecution(input({
    mode: MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS,
    lastMigrationExport: CURRENT_MARKER,
    dependencies: dependencies(snapshotCalls),
  }));
  assert.deepEqual(snapshotResult.execution.builtActions, ['rebuild_daily_snapshot']);
  assert.deepEqual(snapshotCalls, { integrity: 1, snapshot: 1, artifact: 1, migration: 0 });

  const exportCalls = {};
  const exportResult = await runMaintenanceExecution(input({
    mode: MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS,
    lastDailySnapshot: CURRENT_MARKER,
    dependencies: dependencies(exportCalls),
  }));
  assert.deepEqual(exportResult.execution.builtActions, ['generate_migration_export']);
  assert.deepEqual(exportCalls, { integrity: 1, snapshot: 0, artifact: 0, migration: 1 });
});

test('两个工件的快照Hash不一致时失败关闭', async () => {
  const calls = {};
  const deps = dependencies(calls);
  deps.buildMigrationBundle = async () => migrationBundle({ snapshotSha256: 'c'.repeat(64) });
  await assert.rejects(
    () => runMaintenanceExecution(input({
      mode: MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS,
      dependencies: deps,
    })),
    error => error instanceof MaintenanceExecutionError
      && error.code === 'MAINTENANCE_EXECUTION_SOURCE_DRIFT',
  );
});

test('工件版本漂移或报告执行过变更时拒绝', async () => {
  const driftDeps = dependencies({});
  driftDeps.buildSnapshotArtifact = async () => snapshotArtifact({ publicVersion: VERSION + 1 });
  await assert.rejects(
    () => runMaintenanceExecution(input({
      mode: MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS,
      lastMigrationExport: CURRENT_MARKER,
      dependencies: driftDeps,
    })),
    error => error instanceof MaintenanceExecutionError
      && error.code === 'MAINTENANCE_EXECUTION_SNAPSHOT_ARTIFACT_INVALID',
  );

  const mutationDeps = dependencies({});
  mutationDeps.buildMigrationBundle = async () => migrationBundle({ mutationsPerformed: 1 });
  await assert.rejects(
    () => runMaintenanceExecution(input({
      mode: MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS,
      lastDailySnapshot: CURRENT_MARKER,
      dependencies: mutationDeps,
    })),
    error => error instanceof MaintenanceExecutionError
      && error.code === 'MAINTENANCE_EXECUTION_MIGRATION_ARTIFACT_INVALID',
  );
});

test('候选库存告警保留人工动作但不阻止公共工件构建', async () => {
  const deps = dependencies({});
  deps.buildIntegrityReport = async () => report({
    status: 'attention_required',
    inventory: {
      storedCandidateObjectCount: 120,
      invalidCandidateTimeCount: 0,
      oldestStoredCandidateAgeMs: 25 * 60 * 60 * 1000,
    },
  });
  const result = await runMaintenanceExecution(input({
    mode: MAINTENANCE_EXECUTION_MODE_BUILD_DUE_ARTIFACTS,
    dependencies: deps,
  }));
  assert.equal(result.status, 'attention_required');
  assert.deepEqual(result.execution.builtActions, [
    'rebuild_daily_snapshot',
    'generate_migration_export',
  ]);
  assert.deepEqual(result.execution.deferredActions, ['review_candidate_inventory']);
});

test('无效模式与底层读取失败均稳定失败关闭', async () => {
  let reads = 0;
  await assert.rejects(
    () => runMaintenanceExecution(input({
      mode: 'invalid_mode',
      dependencies: {
        buildIntegrityReport: async () => {
          reads += 1;
          return report();
        },
      },
    })),
    error => error instanceof MaintenanceExecutionError
      && error.code === 'MAINTENANCE_EXECUTION_MODE_INVALID',
  );
  assert.equal(reads, 0);

  await assert.rejects(
    () => runMaintenanceExecution(input({
      dependencies: {
        buildIntegrityReport: async () => {
          throw Object.assign(new Error('temporary'), { status: 503 });
        },
      },
    })),
    error => error instanceof MaintenanceExecutionError
      && error.code === 'MAINTENANCE_EXECUTION_INTEGRITY_FAILED'
      && error.status === 503,
  );
});
