import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAINTENANCE_DAY_MS,
  MaintenanceDailyPlanError,
  buildDailyMaintenancePlan,
} from '../src/server/maintenance_daily_plan_v1.js';

const NOW = Date.parse('2026-07-20T12:00:00.000Z');

function integrityReport(overrides = {}) {
  const publicSummary = {
    ordinaryVersion: 2,
    sensitiveEventCount: 2,
    publicVersion: 4,
    snapshotVersion: 4,
    recordCount: 3,
    tombstoneCount: 1,
    latestChangeAt: '2026-07-20T10:00:00.000Z',
    ...(overrides.public || {}),
  };
  const inventory = {
    storedCandidateObjectCount: 0,
    invalidCandidateTimeCount: 0,
    oldestStoredCandidateAgeMs: null,
    ...(overrides.inventory || {}),
  };
  return {
    schemaVersion: 1,
    scope: { groupId: 'group_fixture', libraryId: 'lib_receive_fixture' },
    checkedAt: '2026-07-20T11:59:00.000Z',
    status: 'healthy',
    readOnly: true,
    mutationsPerformed: 0,
    public: publicSummary,
    inventory,
    checks: {
      ordinaryEventChainValid: true,
      sensitiveEventChainValid: true,
      snapshotScopeValid: true,
      snapshotVersionValid: true,
      snapshotCursorValid: true,
      businessKeyPartitionValid: true,
      strongInventoryRead: true,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['public', 'inventory'].includes(key))),
  };
}

function marker(publicVersion = 4, completedAt = '2026-07-20T11:00:00.000Z') {
  return { publicVersion, completedAt };
}

test('同版本且维护时间未到时返回健康计划且不产生动作', () => {
  const plan = buildDailyMaintenancePlan({
    integrityReport: integrityReport(),
    lastDailySnapshot: marker(),
    lastMigrationExport: marker(),
    now: NOW,
  });

  assert.equal(plan.status, 'healthy');
  assert.equal(plan.readOnly, true);
  assert.equal(plan.mutationsPerformed, 0);
  assert.equal(plan.tasks.snapshot.due, false);
  assert.equal(plan.tasks.migrationExport.due, false);
  assert.equal(plan.tasks.candidates.severity, 'healthy');
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.nextRecommendedRunAt, '2026-07-21T11:00:00.000Z');
});

test('缺少每日快照和迁移导出标记时生成两项只读待办', () => {
  const plan = buildDailyMaintenancePlan({ integrityReport: integrityReport(), now: NOW });

  assert.equal(plan.status, 'maintenance_due');
  assert.equal(plan.tasks.snapshot.reason, 'missing_marker');
  assert.equal(plan.tasks.migrationExport.reason, 'missing_marker');
  assert.deepEqual(plan.actions.map(item => item.type), [
    'rebuild_daily_snapshot',
    'generate_migration_export',
  ]);
  assert.equal(plan.nextRecommendedRunAt, '2026-07-20T12:00:00.000Z');
});

test('公共版本前进时即使未满一天也要求重建快照和导出', () => {
  const plan = buildDailyMaintenancePlan({
    integrityReport: integrityReport(),
    lastDailySnapshot: marker(3),
    lastMigrationExport: marker(3),
    now: NOW,
  });

  assert.equal(plan.tasks.snapshot.reason, 'public_version_advanced');
  assert.equal(plan.tasks.migrationExport.reason, 'public_version_advanced');
  assert.equal(plan.actions.length, 2);
});

test('相同公共版本超过维护间隔后重新生成每日产物', () => {
  const oldTime = new Date(NOW - MAINTENANCE_DAY_MS).toISOString();
  const plan = buildDailyMaintenancePlan({
    integrityReport: integrityReport(),
    lastDailySnapshot: marker(4, oldTime),
    lastMigrationExport: marker(4, oldTime),
    now: NOW,
  });

  assert.equal(plan.tasks.snapshot.reason, 'interval_elapsed');
  assert.equal(plan.tasks.migrationExport.reason, 'interval_elapsed');
  assert.equal(plan.status, 'maintenance_due');
});

test('候选数量达到警告阈值时要求人工复核库存', () => {
  const plan = buildDailyMaintenancePlan({
    integrityReport: integrityReport({
      inventory: {
        storedCandidateObjectCount: 100,
        oldestStoredCandidateAgeMs: 60_000,
      },
    }),
    lastDailySnapshot: marker(),
    lastMigrationExport: marker(),
    now: NOW,
  });

  assert.equal(plan.status, 'attention_required');
  assert.equal(plan.tasks.candidates.severity, 'warning');
  assert.deepEqual(plan.tasks.candidates.reasons, ['warning_object_count']);
  assert.deepEqual(plan.actions.map(item => item.type), ['review_candidate_inventory']);
});

test('候选时间异常属于严重状态并生成独立调查动作', () => {
  const plan = buildDailyMaintenancePlan({
    integrityReport: integrityReport({
      status: 'attention_required',
      inventory: {
        storedCandidateObjectCount: 2,
        invalidCandidateTimeCount: 1,
        oldestStoredCandidateAgeMs: 10_000,
      },
    }),
    lastDailySnapshot: marker(),
    lastMigrationExport: marker(),
    now: NOW,
  });

  assert.equal(plan.status, 'attention_required');
  assert.equal(plan.tasks.candidates.severity, 'critical');
  assert.deepEqual(plan.actions.map(item => item.type), [
    'review_candidate_inventory',
    'investigate_invalid_candidate_time',
  ]);
  assert.equal(plan.actions[0].priority, 'high');
});

test('候选年龄达到严重阈值时进入高优先级复核', () => {
  const plan = buildDailyMaintenancePlan({
    integrityReport: integrityReport({
      inventory: {
        storedCandidateObjectCount: 1,
        oldestStoredCandidateAgeMs: 3 * MAINTENANCE_DAY_MS,
      },
    }),
    lastDailySnapshot: marker(),
    lastMigrationExport: marker(),
    now: NOW,
  });

  assert.equal(plan.tasks.candidates.severity, 'critical');
  assert.deepEqual(plan.tasks.candidates.reasons, ['critical_oldest_age']);
  assert.equal(plan.actions[0].priority, 'high');
});

test('维护标记不能领先于当前公共版本', () => {
  assert.throws(
    () => buildDailyMaintenancePlan({
      integrityReport: integrityReport(),
      lastDailySnapshot: marker(5),
      lastMigrationExport: marker(),
      now: NOW,
    }),
    error => error instanceof MaintenanceDailyPlanError
      && error.code === 'MAINTENANCE_PLAN_MARKER_AHEAD',
  );
});

test('维护标记不能来自未来', () => {
  assert.throws(
    () => buildDailyMaintenancePlan({
      integrityReport: integrityReport(),
      lastDailySnapshot: marker(4, '2026-07-20T13:00:00.000Z'),
      lastMigrationExport: marker(),
      now: NOW,
    }),
    error => error instanceof MaintenanceDailyPlanError
      && error.code === 'MAINTENANCE_PLAN_MARKER_FROM_FUTURE',
  );
});

test('阶段7A核查未全绿时失败关闭', () => {
  const report = integrityReport();
  report.checks.snapshotCursorValid = false;
  assert.throws(
    () => buildDailyMaintenancePlan({
      integrityReport: report,
      lastDailySnapshot: marker(),
      lastMigrationExport: marker(),
      now: NOW,
    }),
    error => error instanceof MaintenanceDailyPlanError
      && error.code === 'MAINTENANCE_PLAN_INTEGRITY_CHECK_FAILED',
  );
});

test('警告阈值必须严格低于严重阈值', () => {
  assert.throws(
    () => buildDailyMaintenancePlan({
      integrityReport: integrityReport(),
      lastDailySnapshot: marker(),
      lastMigrationExport: marker(),
      thresholds: { candidateWarningCount: 500 },
      now: NOW,
    }),
    error => error instanceof MaintenanceDailyPlanError
      && error.code === 'MAINTENANCE_PLAN_THRESHOLDS_INVALID',
  );
});
