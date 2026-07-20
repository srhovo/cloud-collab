export const MAINTENANCE_DAILY_PLAN_VERSION = 1;
export const MAINTENANCE_DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_MAINTENANCE_THRESHOLDS = Object.freeze({
  snapshotIntervalMs: MAINTENANCE_DAY_MS,
  exportIntervalMs: MAINTENANCE_DAY_MS,
  candidateWarningCount: 100,
  candidateCriticalCount: 500,
  candidateMaxAgeMs: MAINTENANCE_DAY_MS,
  candidateCriticalAgeMs: 3 * MAINTENANCE_DAY_MS,
});

const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;
const MAX_VERSION = 999_999_999_999;

export class MaintenanceDailyPlanError extends Error {
  constructor(code, message, status = 500, details = null) {
    super(message || code || '每日维护计划生成失败');
    this.name = 'MaintenanceDailyPlanError';
    this.code = code || 'MAINTENANCE_DAILY_PLAN_ERROR';
    this.status = status;
    this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertSafeInteger(value, code, message, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new MaintenanceDailyPlanError(code, message, 400, { value, min, max });
  }
  return value;
}

function assertTimestamp(value, code, message) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new MaintenanceDailyPlanError(code, message, 400, { value });
  }
  return timestamp;
}

function normalizeScope(value) {
  if (!isPlainObject(value)) {
    throw new MaintenanceDailyPlanError('MAINTENANCE_PLAN_SCOPE_INVALID', '维护报告作用域无效', 400);
  }
  const groupId = String(value.groupId || '').trim().toLowerCase();
  const libraryId = String(value.libraryId || '').trim().toLowerCase();
  if (!GROUP_ID_PATTERN.test(groupId) || !LIBRARY_ID_PATTERN.test(libraryId)) {
    throw new MaintenanceDailyPlanError('MAINTENANCE_PLAN_SCOPE_INVALID', '维护报告作用域格式无效', 400);
  }
  return Object.freeze({ groupId, libraryId });
}

function normalizeChecks(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0
      || Object.values(value).some(item => item !== true)) {
    throw new MaintenanceDailyPlanError(
      'MAINTENANCE_PLAN_INTEGRITY_CHECK_FAILED',
      '阶段7A完整性核查未全部通过，禁止生成维护执行计划',
      409,
    );
  }
  return Object.freeze({ ...value });
}

function normalizeIntegrityReport(value, now) {
  if (!isPlainObject(value) || value.schemaVersion !== 1
      || value.readOnly !== true || value.mutationsPerformed !== 0) {
    throw new MaintenanceDailyPlanError('MAINTENANCE_PLAN_REPORT_INVALID', '阶段7A维护报告结构无效', 400);
  }

  const scope = normalizeScope(value.scope);
  const checkedAtMs = assertTimestamp(
    value.checkedAt,
    'MAINTENANCE_PLAN_REPORT_TIME_INVALID',
    '阶段7A维护报告时间无效',
  );
  if (checkedAtMs > now) {
    throw new MaintenanceDailyPlanError('MAINTENANCE_PLAN_REPORT_FROM_FUTURE', '阶段7A维护报告时间晚于计划时间', 409);
  }

  if (!['healthy', 'attention_required'].includes(value.status)) {
    throw new MaintenanceDailyPlanError('MAINTENANCE_PLAN_REPORT_STATUS_INVALID', '阶段7A维护报告状态无效', 400);
  }
  if (!isPlainObject(value.public) || !isPlainObject(value.inventory)) {
    throw new MaintenanceDailyPlanError('MAINTENANCE_PLAN_REPORT_INVALID', '阶段7A维护报告摘要无效', 400);
  }

  const ordinaryVersion = assertSafeInteger(
    value.public.ordinaryVersion,
    'MAINTENANCE_PLAN_PUBLIC_VERSION_INVALID',
    '普通公共版本无效',
    { max: MAX_VERSION },
  );
  const publicVersion = assertSafeInteger(
    value.public.publicVersion,
    'MAINTENANCE_PLAN_PUBLIC_VERSION_INVALID',
    '统一公共版本无效',
    { max: MAX_VERSION },
  );
  const snapshotVersion = assertSafeInteger(
    value.public.snapshotVersion,
    'MAINTENANCE_PLAN_SNAPSHOT_VERSION_INVALID',
    '统一快照版本无效',
    { max: MAX_VERSION },
  );
  if (ordinaryVersion > publicVersion || snapshotVersion !== publicVersion) {
    throw new MaintenanceDailyPlanError(
      'MAINTENANCE_PLAN_PUBLIC_VERSION_MISMATCH',
      '阶段7A公共版本与快照版本不一致',
      409,
      { ordinaryVersion, publicVersion, snapshotVersion },
    );
  }

  const storedCandidateObjectCount = assertSafeInteger(
    value.inventory.storedCandidateObjectCount,
    'MAINTENANCE_PLAN_CANDIDATE_COUNT_INVALID',
    '候选库存数量无效',
  );
  const invalidCandidateTimeCount = assertSafeInteger(
    value.inventory.invalidCandidateTimeCount,
    'MAINTENANCE_PLAN_CANDIDATE_TIME_COUNT_INVALID',
    '候选异常时间数量无效',
  );
  let oldestStoredCandidateAgeMs = value.inventory.oldestStoredCandidateAgeMs;
  if (oldestStoredCandidateAgeMs !== null) {
    oldestStoredCandidateAgeMs = assertSafeInteger(
      oldestStoredCandidateAgeMs,
      'MAINTENANCE_PLAN_CANDIDATE_AGE_INVALID',
      '最老候选年龄无效',
    );
  }
  if (storedCandidateObjectCount === 0 && oldestStoredCandidateAgeMs !== null) {
    throw new MaintenanceDailyPlanError(
      'MAINTENANCE_PLAN_CANDIDATE_INVENTORY_MISMATCH',
      '空候选库存不能存在最老候选年龄',
      409,
    );
  }
  if (invalidCandidateTimeCount > storedCandidateObjectCount) {
    throw new MaintenanceDailyPlanError(
      'MAINTENANCE_PLAN_CANDIDATE_INVENTORY_MISMATCH',
      '异常候选时间数量超过候选库存数量',
      409,
    );
  }

  return Object.freeze({
    scope,
    checkedAtMs,
    status: value.status,
    public: Object.freeze({ ordinaryVersion, publicVersion, snapshotVersion }),
    inventory: Object.freeze({
      storedCandidateObjectCount,
      invalidCandidateTimeCount,
      oldestStoredCandidateAgeMs,
    }),
    checks: normalizeChecks(value.checks),
  });
}

function normalizeThresholds(value = {}) {
  if (!isPlainObject(value)) {
    throw new MaintenanceDailyPlanError('MAINTENANCE_PLAN_THRESHOLDS_INVALID', '维护阈值必须为对象', 400);
  }
  const merged = { ...DEFAULT_MAINTENANCE_THRESHOLDS, ...value };
  for (const key of Object.keys(DEFAULT_MAINTENANCE_THRESHOLDS)) {
    assertSafeInteger(
      merged[key],
      'MAINTENANCE_PLAN_THRESHOLDS_INVALID',
      `维护阈值${key}无效`,
      { min: 1 },
    );
  }
  if (merged.candidateWarningCount >= merged.candidateCriticalCount
      || merged.candidateMaxAgeMs >= merged.candidateCriticalAgeMs) {
    throw new MaintenanceDailyPlanError(
      'MAINTENANCE_PLAN_THRESHOLDS_INVALID',
      '候选警告阈值必须低于严重阈值',
      400,
    );
  }
  return Object.freeze(merged);
}

function normalizeMarker(value, label, currentPublicVersion, now) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    throw new MaintenanceDailyPlanError('MAINTENANCE_PLAN_MARKER_INVALID', `${label}标记无效`, 400);
  }
  const publicVersion = assertSafeInteger(
    value.publicVersion,
    'MAINTENANCE_PLAN_MARKER_VERSION_INVALID',
    `${label}公共版本无效`,
    { max: MAX_VERSION },
  );
  if (publicVersion > currentPublicVersion) {
    throw new MaintenanceDailyPlanError(
      'MAINTENANCE_PLAN_MARKER_AHEAD',
      `${label}版本不能领先于当前公共版本`,
      409,
      { markerVersion: publicVersion, currentPublicVersion },
    );
  }
  const completedAtMs = assertTimestamp(
    value.completedAt,
    'MAINTENANCE_PLAN_MARKER_TIME_INVALID',
    `${label}完成时间无效`,
  );
  if (completedAtMs > now) {
    throw new MaintenanceDailyPlanError('MAINTENANCE_PLAN_MARKER_FROM_FUTURE', `${label}完成时间晚于计划时间`, 409);
  }
  return Object.freeze({ publicVersion, completedAtMs });
}

function evaluateRecurringTask(marker, currentPublicVersion, intervalMs, now) {
  if (!marker) {
    return Object.freeze({ due: true, reason: 'missing_marker', lastCompletedAt: null, lastPublicVersion: null });
  }
  if (marker.publicVersion < currentPublicVersion) {
    return Object.freeze({
      due: true,
      reason: 'public_version_advanced',
      lastCompletedAt: new Date(marker.completedAtMs).toISOString(),
      lastPublicVersion: marker.publicVersion,
    });
  }
  if (now - marker.completedAtMs >= intervalMs) {
    return Object.freeze({
      due: true,
      reason: 'interval_elapsed',
      lastCompletedAt: new Date(marker.completedAtMs).toISOString(),
      lastPublicVersion: marker.publicVersion,
    });
  }
  return Object.freeze({
    due: false,
    reason: 'up_to_date',
    lastCompletedAt: new Date(marker.completedAtMs).toISOString(),
    lastPublicVersion: marker.publicVersion,
  });
}

function evaluateCandidates(inventory, thresholds) {
  const reasons = [];
  if (inventory.invalidCandidateTimeCount > 0) reasons.push('invalid_received_at');
  if (inventory.storedCandidateObjectCount >= thresholds.candidateCriticalCount) reasons.push('critical_object_count');
  else if (inventory.storedCandidateObjectCount >= thresholds.candidateWarningCount) reasons.push('warning_object_count');

  if (inventory.oldestStoredCandidateAgeMs !== null) {
    if (inventory.oldestStoredCandidateAgeMs >= thresholds.candidateCriticalAgeMs) reasons.push('critical_oldest_age');
    else if (inventory.oldestStoredCandidateAgeMs >= thresholds.candidateMaxAgeMs) reasons.push('warning_oldest_age');
  }

  const critical = reasons.some(reason => reason.startsWith('critical_') || reason === 'invalid_received_at');
  const warning = !critical && reasons.some(reason => reason.startsWith('warning_'));
  return Object.freeze({
    severity: critical ? 'critical' : warning ? 'warning' : 'healthy',
    reasons: Object.freeze(reasons),
    storedCandidateObjectCount: inventory.storedCandidateObjectCount,
    invalidCandidateTimeCount: inventory.invalidCandidateTimeCount,
    oldestStoredCandidateAgeMs: inventory.oldestStoredCandidateAgeMs,
  });
}

function buildActions(snapshot, migrationExport, candidates) {
  const actions = [];
  if (snapshot.due) actions.push(Object.freeze({ type: 'rebuild_daily_snapshot', priority: 'normal', reason: snapshot.reason }));
  if (migrationExport.due) actions.push(Object.freeze({ type: 'generate_migration_export', priority: 'normal', reason: migrationExport.reason }));
  if (candidates.severity !== 'healthy') {
    actions.push(Object.freeze({
      type: 'review_candidate_inventory',
      priority: candidates.severity === 'critical' ? 'high' : 'normal',
      reason: candidates.reasons[0],
    }));
  }
  if (candidates.reasons.includes('invalid_received_at')) {
    actions.push(Object.freeze({
      type: 'investigate_invalid_candidate_time',
      priority: 'high',
      reason: 'invalid_received_at',
    }));
  }
  return Object.freeze(actions);
}

function nextRunAt({ snapshotMarker, exportMarker, thresholds, now, actions }) {
  if (actions.length > 0) return new Date(now).toISOString();
  const candidates = [
    snapshotMarker.completedAtMs + thresholds.snapshotIntervalMs,
    exportMarker.completedAtMs + thresholds.exportIntervalMs,
  ];
  return new Date(Math.min(...candidates)).toISOString();
}

export function buildDailyMaintenancePlan({
  integrityReport,
  lastDailySnapshot = null,
  lastMigrationExport = null,
  thresholds = {},
  now = Date.now(),
} = {}) {
  const plannedAtMs = assertSafeInteger(
    now,
    'MAINTENANCE_PLAN_TIME_INVALID',
    '维护计划时间无效',
    { min: 1, max: 9_999_999_999_999 },
  );
  const normalizedReport = normalizeIntegrityReport(integrityReport, plannedAtMs);
  const normalizedThresholds = normalizeThresholds(thresholds);
  const snapshotMarker = normalizeMarker(
    lastDailySnapshot,
    '每日快照',
    normalizedReport.public.publicVersion,
    plannedAtMs,
  );
  const exportMarker = normalizeMarker(
    lastMigrationExport,
    '迁移导出',
    normalizedReport.public.publicVersion,
    plannedAtMs,
  );

  const snapshot = evaluateRecurringTask(
    snapshotMarker,
    normalizedReport.public.publicVersion,
    normalizedThresholds.snapshotIntervalMs,
    plannedAtMs,
  );
  const migrationExport = evaluateRecurringTask(
    exportMarker,
    normalizedReport.public.publicVersion,
    normalizedThresholds.exportIntervalMs,
    plannedAtMs,
  );
  const candidates = evaluateCandidates(normalizedReport.inventory, normalizedThresholds);
  const actions = buildActions(snapshot, migrationExport, candidates);

  const status = candidates.severity !== 'healthy' || normalizedReport.status === 'attention_required'
    ? 'attention_required'
    : actions.length > 0
      ? 'maintenance_due'
      : 'healthy';

  return Object.freeze({
    schemaVersion: MAINTENANCE_DAILY_PLAN_VERSION,
    scope: normalizedReport.scope,
    plannedAt: new Date(plannedAtMs).toISOString(),
    sourceCheckedAt: new Date(normalizedReport.checkedAtMs).toISOString(),
    status,
    readOnly: true,
    mutationsPerformed: 0,
    currentPublicVersion: normalizedReport.public.publicVersion,
    policy: normalizedThresholds,
    tasks: Object.freeze({ snapshot, migrationExport, candidates }),
    actions,
    nextRecommendedRunAt: nextRunAt({
      snapshotMarker,
      exportMarker,
      thresholds: normalizedThresholds,
      now: plannedAtMs,
      actions,
    }),
  });
}
