import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMaintenanceIntegrityReport,
  MaintenanceIntegrityError,
} from '../src/server/maintenance_integrity_v1.js';

const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const NOW = 1_785_000_000_000;
const BK_A = `bk_v1_${'A'.repeat(43)}`;
const BK_B = `bk_v1_${'B'.repeat(43)}`;
const BK_C = `bk_v1_${'C'.repeat(43)}`;

class MemoryStore {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  async get(key) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }

  async setJSON(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list({ prefix }) {
    return {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
}

function snapshot({
  baseOrdinaryVersion = 0,
  publicVersion = baseOrdinaryVersion,
  records = [],
  tombstones = [],
} = {}) {
  return {
    schemaVersion: 2,
    payloadSchemaVersion: 1,
    groupId: GROUP,
    libraryId: LIBRARY,
    baseOrdinaryVersion,
    publicVersion,
    snapshotVersion: publicVersion,
    cursor: `pv_${publicVersion}`,
    generatedAt: new Date(NOW).toISOString(),
    records,
    tombstones,
  };
}

function deps({ ordinary = [], sensitive = [], publicSnapshot = snapshot() } = {}) {
  return {
    listOrdinaryEvents: async () => ordinary,
    listSensitiveEvents: async () => sensitive,
    buildSnapshot: async () => publicSnapshot,
  };
}

function event(version, approvedAt) {
  return { version, approvedAt };
}

test('阶段7A空公共库只读完整性核查为健康且不执行写入', async () => {
  const store = new MemoryStore();
  const report = await buildMaintenanceIntegrityReport({
    store,
    groupId: GROUP,
    libraryId: LIBRARY,
    now: NOW,
    dependencies: deps(),
  });

  assert.equal(report.status, 'healthy');
  assert.equal(report.readOnly, true);
  assert.equal(report.mutationsPerformed, 0);
  assert.deepEqual(report.public, {
    ordinaryVersion: 0,
    sensitiveEventCount: 0,
    publicVersion: 0,
    snapshotVersion: 0,
    recordCount: 0,
    tombstoneCount: 0,
    latestChangeAt: null,
  });
  assert.deepEqual(report.inventory, {
    storedCandidateObjectCount: 0,
    invalidCandidateTimeCount: 0,
    oldestStoredCandidateAgeMs: null,
  });
  assert.equal(report.checks.strongInventoryRead, true);
});

test('阶段7A汇总普通与敏感连续事件、快照记录、墓碑和候选库存', async () => {
  const validReceivedAt = NOW - 86_400_000;
  const store = new MemoryStore([
    [`submissions/${LIBRARY}/pending/ik_v1_${'A'.repeat(43)}.json`, { receivedAt: validReceivedAt }],
    [`submissions/${LIBRARY}/pending/ik_v1_${'B'.repeat(43)}.json`, { receivedAt: 'bad' }],
  ]);
  const ordinary = [
    event(1, '2026-07-20T10:00:00.000Z'),
    event(2, '2026-07-20T10:10:00.000Z'),
  ];
  const sensitive = [
    event(3, '2026-07-20T10:20:00.000Z'),
    event(4, '2026-07-20T10:30:00.000Z'),
  ];
  const publicSnapshot = snapshot({
    baseOrdinaryVersion: 2,
    publicVersion: 4,
    records: [
      { businessKey: BK_A },
      { businessKey: BK_B },
    ],
    tombstones: [{ businessKey: BK_C }],
  });

  const report = await buildMaintenanceIntegrityReport({
    store,
    groupId: GROUP,
    libraryId: LIBRARY,
    now: NOW,
    dependencies: deps({ ordinary, sensitive, publicSnapshot }),
  });

  assert.equal(report.status, 'attention_required');
  assert.equal(report.public.ordinaryVersion, 2);
  assert.equal(report.public.sensitiveEventCount, 2);
  assert.equal(report.public.publicVersion, 4);
  assert.equal(report.public.recordCount, 2);
  assert.equal(report.public.tombstoneCount, 1);
  assert.equal(report.public.latestChangeAt, '2026-07-20T10:30:00.000Z');
  assert.equal(report.inventory.storedCandidateObjectCount, 2);
  assert.equal(report.inventory.invalidCandidateTimeCount, 1);
  assert.equal(report.inventory.oldestStoredCandidateAgeMs, 86_400_000);
});

test('阶段7A拒绝不连续的普通或敏感公共版本链', async () => {
  await assert.rejects(
    buildMaintenanceIntegrityReport({
      store: new MemoryStore(),
      groupId: GROUP,
      libraryId: LIBRARY,
      now: NOW,
      dependencies: deps({ ordinary: [event(2, '2026-07-20T10:00:00.000Z')] }),
    }),
    error => error instanceof MaintenanceIntegrityError
      && error.code === 'MAINTENANCE_ORDINARY_CHAIN_INVALID',
  );

  await assert.rejects(
    buildMaintenanceIntegrityReport({
      store: new MemoryStore(),
      groupId: GROUP,
      libraryId: LIBRARY,
      now: NOW,
      dependencies: deps({
        ordinary: [event(1, '2026-07-20T10:00:00.000Z')],
        sensitive: [event(3, '2026-07-20T10:10:00.000Z')],
        publicSnapshot: snapshot({ baseOrdinaryVersion: 1, publicVersion: 3 }),
      }),
    }),
    error => error instanceof MaintenanceIntegrityError
      && error.code === 'MAINTENANCE_SENSITIVE_CHAIN_INVALID',
  );
});

test('阶段7A拒绝公共版本、快照版本或游标不一致', async () => {
  const broken = snapshot({ baseOrdinaryVersion: 1, publicVersion: 1 });
  broken.snapshotVersion = 2;
  await assert.rejects(
    buildMaintenanceIntegrityReport({
      store: new MemoryStore(),
      groupId: GROUP,
      libraryId: LIBRARY,
      now: NOW,
      dependencies: deps({
        ordinary: [event(1, '2026-07-20T10:00:00.000Z')],
        publicSnapshot: broken,
      }),
    }),
    error => error instanceof MaintenanceIntegrityError
      && error.code === 'MAINTENANCE_SNAPSHOT_VERSION_MISMATCH',
  );

  const wrongCursor = snapshot({ baseOrdinaryVersion: 1, publicVersion: 1 });
  wrongCursor.cursor = 'pv_0';
  await assert.rejects(
    buildMaintenanceIntegrityReport({
      store: new MemoryStore(),
      groupId: GROUP,
      libraryId: LIBRARY,
      now: NOW,
      dependencies: deps({
        ordinary: [event(1, '2026-07-20T10:00:00.000Z')],
        publicSnapshot: wrongCursor,
      }),
    }),
    error => error instanceof MaintenanceIntegrityError
      && error.code === 'MAINTENANCE_SNAPSHOT_CURSOR_MISMATCH',
  );
});

test('阶段7A拒绝重复业务键以及生效记录与墓碑重叠', async () => {
  await assert.rejects(
    buildMaintenanceIntegrityReport({
      store: new MemoryStore(),
      groupId: GROUP,
      libraryId: LIBRARY,
      now: NOW,
      dependencies: deps({
        publicSnapshot: snapshot({ records: [{ businessKey: BK_A }, { businessKey: BK_A }] }),
      }),
    }),
    error => error instanceof MaintenanceIntegrityError
      && error.code === 'MAINTENANCE_DUPLICATE_ACTIVE_RECORD',
  );

  await assert.rejects(
    buildMaintenanceIntegrityReport({
      store: new MemoryStore(),
      groupId: GROUP,
      libraryId: LIBRARY,
      now: NOW,
      dependencies: deps({
        publicSnapshot: snapshot({
          records: [{ businessKey: BK_A }],
          tombstones: [{ businessKey: BK_A }],
        }),
      }),
    }),
    error => error instanceof MaintenanceIntegrityError
      && error.code === 'MAINTENANCE_ACTIVE_TOMBSTONE_OVERLAP',
  );
});

test('阶段7A强一致候选库存读取拒绝越界Key', async () => {
  const store = new MemoryStore();
  store.list = async () => ({ blobs: [{ key: 'other-scope/object.json' }] });
  await assert.rejects(
    buildMaintenanceIntegrityReport({
      store,
      groupId: GROUP,
      libraryId: LIBRARY,
      now: NOW,
      dependencies: deps(),
    }),
    error => error instanceof MaintenanceIntegrityError
      && error.code === 'MAINTENANCE_INVENTORY_INVALID',
  );
});
