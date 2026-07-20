import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDailySnapshotArtifact,
  buildMaintenanceMigrationBundle,
  MaintenanceMigrationBundleError,
} from '../src/server/maintenance_migration_bundle_v1.js';

const NOW = Date.parse('2026-07-20T16:30:00.000Z');
const GROUP_ID = 'group_fixture';
const LIBRARY_ID = 'lib_receive_fixture';
const key = letter => `bk_v1_${letter.repeat(43)}`;
const hash = letter => `ch_v1_${letter.repeat(43)}`;
const bossId = `boss_v1_${'B'.repeat(43)}`;

function ordinaryEvent({ version, letter, dataType, payload, baseline = null }) {
  return Object.freeze({
    version,
    approvedAt: new Date(NOW - (10 - version) * 1000).toISOString(),
    businessKey: key(letter),
    contentHash: hash(letter.toLowerCase()),
    dataType,
    operation: 'upsert',
    payload,
    baseline: baseline || { approvedVersion: 0, contentHash: null, unitPrice: null },
    approval: {
      mode: 'two_devices_match',
      deviceIds: [`dev_${'0'.repeat(25)}1`, `dev_${'0'.repeat(25)}2`],
      submissionIds: [`sub_${'0'.repeat(25)}1`, `sub_${'0'.repeat(25)}2`],
    },
  });
}

function sensitiveEvent({ version, letter, dataType, operation = 'upsert', payload, baseline, eventBossId = null }) {
  return Object.freeze({
    version,
    approvedAt: new Date(NOW - (10 - version) * 1000).toISOString(),
    businessKey: key(letter),
    contentHash: hash(letter.toLowerCase()),
    dataType,
    operation,
    payload: operation === 'delete' ? null : payload,
    bossId: eventBossId,
    baseline,
    approval: { mode: 'admin_sensitive_approved', actorTag: 'admin_123456789012' },
  });
}

function fixture() {
  const ordinaryEvents = [
    ordinaryEvent({
      version: 1,
      letter: 'A',
      dataType: 'exact_price',
      payload: { serviceName: '测试服务', unit: 'round', unitPrice: 10 },
    }),
    ordinaryEvent({
      version: 2,
      letter: 'B',
      dataType: 'playable_name',
      payload: { name: '测试陪玩' },
    }),
    ordinaryEvent({
      version: 3,
      letter: 'C',
      dataType: 'boss_profile',
      payload: { bossName: '测试老板', paiDan: '测试直属', discount: 0.95 },
    }),
  ];
  const sensitiveEvents = [
    sensitiveEvent({
      version: 4,
      letter: 'D',
      dataType: 'rank_range_rule',
      payload: {
        rangeLabel: '测试星级', alias: '测星', rankType: 'star', minStar: 0, maxStar: 20,
        namedRanks: [],
        prices: {
          normal: { round: 10, hour: null },
          carry: { round: 15, hour: null },
          starGuarantee: { round: null, hour: 30 },
        },
      },
      baseline: { approvedVersion: 0, contentHash: null },
    }),
    sensitiveEvent({
      version: 5,
      letter: 'E',
      dataType: 'surcharge_rule',
      payload: { name: '测试教学', keywords: ['教学'], prices: { round: 6, hour: 20 }, enabled: true },
      baseline: { approvedVersion: 0, contentHash: null },
    }),
    sensitiveEvent({
      version: 6,
      letter: 'F',
      dataType: 'gift_rule',
      payload: { serviceName: '测试礼物', mode: 'fixed', unitPrice: 67 },
      baseline: { approvedVersion: 0, contentHash: null },
    }),
    sensitiveEvent({
      version: 7,
      letter: 'F',
      dataType: 'gift_rule',
      operation: 'delete',
      payload: null,
      baseline: { approvedVersion: 6, contentHash: hash('f') },
    }),
  ];
  const snapshot = {
    schemaVersion: 2,
    payloadSchemaVersion: 1,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    baseOrdinaryVersion: 3,
    publicVersion: 7,
    snapshotVersion: 7,
    cursor: 'pv_7',
    generatedAt: new Date(NOW - 500).toISOString(),
    records: [
      {
        businessKey: key('A'), contentHash: hash('a'), dataType: 'exact_price', operation: 'upsert',
        approvedVersion: 1, payload: { serviceName: '测试服务', unit: 'round', unitPrice: 10 },
      },
      {
        businessKey: key('B'), contentHash: hash('b'), dataType: 'playable_name', operation: 'upsert',
        approvedVersion: 2, payload: { name: '测试陪玩' },
      },
      {
        businessKey: key('C'), contentHash: hash('c'), dataType: 'boss_profile', operation: 'upsert',
        approvedVersion: 3, bossId, payload: { bossName: '测试老板', paiDan: '测试直属', discount: 0.95 },
      },
      {
        businessKey: key('D'), contentHash: hash('d'), dataType: 'rank_range_rule', operation: 'upsert',
        approvedVersion: 4,
        payload: {
          rangeLabel: '测试星级', alias: '测星', rankType: 'star', minStar: 0, maxStar: 20,
          namedRanks: [],
          prices: {
            normal: { round: 10, hour: null },
            carry: { round: 15, hour: null },
            starGuarantee: { round: null, hour: 30 },
          },
        },
      },
      {
        businessKey: key('E'), contentHash: hash('e'), dataType: 'surcharge_rule', operation: 'upsert',
        approvedVersion: 5,
        payload: { name: '测试教学', keywords: ['教学'], prices: { round: 6, hour: 20 }, enabled: true },
      },
    ],
    tombstones: [
      {
        businessKey: key('F'), contentHash: hash('f'), dataType: 'gift_rule', operation: 'delete',
        approvedVersion: 7,
      },
    ],
  };
  const integrityReport = {
    schemaVersion: 1,
    scope: { groupId: GROUP_ID, libraryId: LIBRARY_ID },
    checkedAt: new Date(NOW - 1000).toISOString(),
    status: 'healthy',
    readOnly: true,
    mutationsPerformed: 0,
    public: {
      ordinaryVersion: 3,
      sensitiveEventCount: 4,
      publicVersion: 7,
      snapshotVersion: 7,
      recordCount: 5,
      tombstoneCount: 1,
      latestChangeAt: sensitiveEvents.at(-1).approvedAt,
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
  };
  return { ordinaryEvents, sensitiveEvents, snapshot, integrityReport };
}

function dependencies(data) {
  return {
    buildIntegrityReport: async () => data.integrityReport,
    listOrdinaryEvents: async () => data.ordinaryEvents,
    listSensitiveEvents: async () => data.sensitiveEvents,
    buildSnapshot: async () => data.snapshot,
  };
}

function readStoredZip(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    files.set(name, buffer.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return files;
}

test('阶段7C生成覆盖六类公共数据与墓碑的确定性迁移包', async () => {
  const data = fixture();
  const first = await buildMaintenanceMigrationBundle({
    store: {}, groupId: GROUP_ID, libraryId: LIBRARY_ID, now: NOW, dependencies: dependencies(data),
  });
  const replay = await buildMaintenanceMigrationBundle({
    store: {}, groupId: GROUP_ID, libraryId: LIBRARY_ID, now: NOW, dependencies: dependencies(data),
  });

  assert.equal(first.readOnly, true);
  assert.equal(first.mutationsPerformed, 0);
  assert.equal(first.publicVersion, 7);
  assert.equal(first.ordinaryVersion, 3);
  assert.equal(first.recordCount, 5);
  assert.equal(first.tombstoneCount, 1);
  assert.equal(first.fileCount, 7);
  assert.equal(first.packageId, replay.packageId);
  assert.equal(first.packageSha256, replay.packageSha256);
  assert.deepEqual(first.bytes, replay.bytes);

  const files = readStoredZip(first.bytes);
  assert.deepEqual([...files.keys()].sort(), [
    '码单器公共数据库迁移包/maintenance/integrity.json',
    '码单器公共数据库迁移包/manifest.json',
    '码单器公共数据库迁移包/public/ordinary-events.json',
    '码单器公共数据库迁移包/public/sensitive-events.json',
    '码单器公共数据库迁移包/public/snapshot.json',
    '码单器公共数据库迁移包/restore/plan.json',
    '码单器公共数据库迁移包/schema.json',
  ]);

  const snapshot = JSON.parse(files.get('码单器公共数据库迁移包/public/snapshot.json').toString('utf8'));
  assert.deepEqual(snapshot.records.map(item => item.dataType).sort(), [
    'boss_profile', 'exact_price', 'playable_name', 'rank_range_rule', 'surcharge_rule',
  ]);
  assert.equal(snapshot.tombstones[0].dataType, 'gift_rule');
  assert.equal(snapshot.records.find(item => item.dataType === 'boss_profile').bossId, bossId);

  const sensitive = JSON.parse(files.get('码单器公共数据库迁移包/public/sensitive-events.json').toString('utf8'));
  assert.equal(sensitive.events.length, 4);
  assert.equal(sensitive.events.at(-1).operation, 'delete');
  assert.equal(sensitive.events.at(-1).payload, null);

  const manifest = JSON.parse(files.get('码单器公共数据库迁移包/manifest.json').toString('utf8'));
  assert.equal(manifest.packageId, first.packageId);
  assert.equal(manifest.automaticMutationAllowed, false);
  assert.equal(manifest.files.length, 6);

  const text = first.bytes.toString('utf8');
  assert.equal(text.includes('deviceId'), false);
  assert.equal(text.includes('submissionId'), false);
  assert.equal(text.includes('admin_123456789012'), false);
  assert.equal(text.includes('dev_00000000000000000000000001'), false);
});

test('每日快照工件输出稳定Hash与可回填标记', () => {
  const data = fixture();
  const artifact = buildDailySnapshotArtifact({
    integrityReport: data.integrityReport,
    snapshot: data.snapshot,
    now: NOW,
  });
  assert.equal(artifact.publicVersion, 7);
  assert.equal(artifact.snapshotVersion, 7);
  assert.equal(artifact.marker.publicVersion, 7);
  assert.equal(artifact.marker.completedAt, new Date(NOW).toISOString());
  assert.equal(artifact.marker.artifactSha256, artifact.sha256);
  assert.equal(artifact.readOnly, true);
  assert.equal(artifact.mutationsPerformed, 0);
  assert.equal(JSON.parse(artifact.bytes.toString('utf8')).records.length, 5);
});

test('同一公共版本跨不同生成时间保持packageId稳定', async () => {
  const data = fixture();
  const first = await buildMaintenanceMigrationBundle({
    store: {}, groupId: GROUP_ID, libraryId: LIBRARY_ID, now: NOW, dependencies: dependencies(data),
  });
  const later = await buildMaintenanceMigrationBundle({
    store: {}, groupId: GROUP_ID, libraryId: LIBRARY_ID, now: NOW + 60_000, dependencies: dependencies(data),
  });
  assert.equal(first.packageId, later.packageId);
  assert.notEqual(first.packageSha256, later.packageSha256);
  assert.equal(later.marker.publicVersion, 7);
});

test('完整性检查非全绿时失败关闭', async () => {
  const data = fixture();
  data.integrityReport = {
    ...data.integrityReport,
    checks: { ...data.integrityReport.checks, snapshotCursorValid: false },
  };
  await assert.rejects(
    () => buildMaintenanceMigrationBundle({
      store: {}, groupId: GROUP_ID, libraryId: LIBRARY_ID, now: NOW, dependencies: dependencies(data),
    }),
    error => error instanceof MaintenanceMigrationBundleError
      && error.code === 'MAINTENANCE_MIGRATION_INTEGRITY_REPORT_INVALID',
  );
});

test('事件版本链与完整性报告不一致时失败关闭', async () => {
  const data = fixture();
  data.sensitiveEvents = data.sensitiveEvents.map((event, index) => (
    index === 1 ? { ...event, version: 8 } : event
  ));
  await assert.rejects(
    () => buildMaintenanceMigrationBundle({
      store: {}, groupId: GROUP_ID, libraryId: LIBRARY_ID, now: NOW, dependencies: dependencies(data),
    }),
    error => error instanceof MaintenanceMigrationBundleError
      && error.code === 'MAINTENANCE_MIGRATION_EVENT_CHAIN_INVALID',
  );
});

test('快照数量与完整性报告不一致时失败关闭', async () => {
  const data = fixture();
  data.snapshot = { ...data.snapshot, records: data.snapshot.records.slice(1) };
  await assert.rejects(
    () => buildMaintenanceMigrationBundle({
      store: {}, groupId: GROUP_ID, libraryId: LIBRARY_ID, now: NOW, dependencies: dependencies(data),
    }),
    error => error instanceof MaintenanceMigrationBundleError
      && error.code === 'MAINTENANCE_MIGRATION_SNAPSHOT_COUNT_MISMATCH',
  );
});

test('公共投影出现设备或内部字段时阻止导出', async () => {
  const data = fixture();
  data.snapshot = {
    ...data.snapshot,
    records: data.snapshot.records.map((record, index) => (
      index === 0 ? { ...record, payload: { ...record.payload, deviceId: 'dev_forbidden' } } : record
    )),
  };
  await assert.rejects(
    () => buildMaintenanceMigrationBundle({
      store: {}, groupId: GROUP_ID, libraryId: LIBRARY_ID, now: NOW, dependencies: dependencies(data),
    }),
    error => error instanceof MaintenanceMigrationBundleError
      && error.code === 'MAINTENANCE_MIGRATION_PRIVATE_FIELD_BLOCKED',
  );
});
