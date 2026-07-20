import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

await import('../src/cloud_collab_snapshot_sync.js');
await import('../src/cloud_collab_submission_client.js');
await import('../src/cloud_collab_ordinary_types_client.js');

const SnapshotSync = globalThis.CloudCollabSnapshotSync;
const OrdinaryTypes = globalThis.CloudCollabOrdinaryTypes;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const methodSource = fs.readFileSync(path.join(root, 'src', 'cloud_collab_ordinary_readonly_methods.fragment.js'), 'utf8');
const Harness = Function('SnapshotSync', 'OrdinaryTypes', `
  globalThis.CloudCollabSnapshotSync = SnapshotSync;
  globalThis.CloudCollabOrdinaryTypes = OrdinaryTypes;
  return class Stage5GReceiveHarness {
    ${methodSource}
    buildWorkingPriceData(_binding, plan) {
      return { data: { libraries: [{ id: 'local_fixture', items: plan.upserts.map(item => item.record.payload) }] }, changed: plan.counts.upserts > 0 || plan.counts.deletes > 0 };
    }
    restoreStoreRaw(store, raw) { return store.restore(raw); }
  };
`)(SnapshotSync, OrdinaryTypes);

const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const BINDING = Object.freeze({
  localLibraryId: 'local_fixture',
  groupId: GROUP,
  libraryId: LIBRARY,
  mode: 'receive',
});

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

class SyncStore {
  constructor(scope) { this.scope = clone(scope); }
  readRaw() { return clone(this.scope); }
  upsertScope(next) { this.scope = clone(next); return this.scope; }
  restore(raw) { this.scope = clone(raw); return true; }
}

class BindingStore {
  constructor() { this.value = { local_fixture: 0 }; }
  readRaw() { return clone(this.value); }
  updateBasePublicVersion(id, version) { this.value[id] = version; return true; }
  restore(raw) { this.value = clone(raw); return true; }
}

async function record(dataType, payload, approvedVersion) {
  const hashes = dataType === 'exact_price'
    ? await SnapshotSync.computeExactPriceHashes(GROUP, LIBRARY, payload)
    : await OrdinaryTypes.computeOrdinaryHashes(GROUP, LIBRARY, dataType, payload);
  return Object.freeze({
    approvedVersion,
    businessKey: hashes.businessKey,
    contentHash: hashes.contentHash,
    dataType,
    operation: 'upsert',
    payload: hashes.payload,
  });
}

async function mixedSnapshot({ playableName = '小明', includeExact = true, includeBoss = true } = {}) {
  const records = [];
  if (includeExact) records.push(await record('exact_price', { serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 88 }, records.length + 1));
  records.push(await record('playable_name', { name: playableName }, records.length + 1));
  if (includeBoss) records.push(await record('boss_profile', { bossName: '老板甲', paiDan: '直属A', discount: 0.97 }, records.length + 1));
  return Object.freeze({
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    groupId: GROUP,
    libraryId: LIBRARY,
    publicVersion: records.length,
    snapshotVersion: records.length,
    cursor: `pv_${records.length}`,
    generatedAt: '2026-07-20T01:00:00.000Z',
    records: Object.freeze(records),
    tombstones: Object.freeze([]),
  });
}

function createHarness({ confirmedNames = [], bossMemory = [], bossSaveFailure = false } = {}) {
  const initialScope = {
    groupId: GROUP,
    libraryId: LIBRARY,
    publicVersion: 0,
    cursor: null,
    lastSuccessfulCheckAt: null,
    baseHashes: {},
    conflicts: [],
  };
  const syncStore = new SyncStore(initialScope);
  const bindingStore = new BindingStore();
  const extractor = {
    data: { confirmedNames: clone(confirmedNames), corrections: [], patterns: [], stats: {}, commonNames: [] },
    snapshotData() { return clone(this.data); },
    markLearningCollectionsDirty() { this.dirty = true; },
    saveData() { this.saved = true; return true; },
    restoreData(value) { this.data = clone(value); this.restored = true; return true; },
  };
  let bossSaveCalls = 0;
  const app = {
    priceLibraries: { libraries: [{ id: 'local_fixture', items: [] }] },
    priceMemory: [],
    bossMemory: clone(bossMemory),
    enhancedExtractor: extractor,
    priceLibraryStore: {
      persist(data) { return { ok: true, data: clone(data), activeItems: clone(data.libraries[0].items) }; },
      restoreSnapshot(canonical, legacy) { app.priceLibraries = clone(canonical); app.priceMemory = clone(legacy); return true; },
    },
    priceMemoryFeature: { updatePriceMemoryUI() {}, refreshServicePriceMatchAfterLibraryChange() {} },
    bossMemoryFeature: {
      save(next) {
        bossSaveCalls += 1;
        if (bossSaveFailure && bossSaveCalls === 1) return false;
        app.bossMemory = clone(next);
        return true;
      },
      refresh() { this.refreshed = true; },
    },
  };
  const harness = new Harness();
  harness.app = app;
  harness.stores = { syncStore, bindingStore };
  return { harness, app, syncStore, bindingStore, initialScope };
}

test('Stage5G splits and verifies mixed exact, playable and boss records before planning', async () => {
  const snapshot = await mixedSnapshot();
  const { harness } = createHarness();
  const split = harness.splitStage5GPublicSnapshot(snapshot);
  assert.equal(split.exactSnapshot.records.length, 1);
  assert.equal(split.ordinaryRecords.length, 2);
  const plans = await harness.planStage5GMixedMerge(BINDING, {
    groupId: GROUP,
    libraryId: LIBRARY,
    publicVersion: 0,
    cursor: null,
    baseHashes: {},
    conflicts: [],
  }, snapshot, { id: 'local_fixture', items: [] });
  assert.equal(plans.exactPlan.counts.upserts, 1);
  assert.equal(plans.ordinaryPlan.counts.upserts, 2);
  assert.equal(Object.keys(plans.ordinaryPlan.nextBaseHashes).length, 3);
});

test('Stage5G mixed commit persists prices, confirmed names, bosses and one shared sync cursor', async () => {
  const snapshot = await mixedSnapshot();
  const { harness, app, syncStore, bindingStore } = createHarness();
  const scope = clone(syncStore.scope);
  const plans = await harness.planStage5GMixedMerge(BINDING, scope, snapshot, { id: 'local_fixture', items: [] });
  const result = harness.commitStage5GMixedPlan(BINDING, scope, plans);
  assert.equal(result.publicVersion, 3);
  assert.equal(result.counts.upserts, 3);
  assert.equal(result.counts.exactPriceUpserts, 1);
  assert.equal(result.counts.playableOrBossUpserts, 2);
  assert.equal(app.priceMemory.length, 1);
  assert.equal(app.enhancedExtractor.data.confirmedNames[0].name, '小明');
  assert.equal(app.enhancedExtractor.data.confirmedNames[0].source, 'cloudPull');
  assert.equal(app.bossMemory[0].name, '老板甲');
  assert.equal(syncStore.scope.publicVersion, 3);
  assert.equal(syncStore.scope.cursor, 'pv_3');
  assert.equal(Object.keys(syncStore.scope.baseHashes).length, 3);
  assert.equal(bindingStore.value.local_fixture, 3);
});

test('Stage5G ordinary three-way merge preserves a locally changed name and records a conflict', async () => {
  const original = await record('playable_name', { name: 'Alice' }, 1);
  const snapshot = await mixedSnapshot({ playableName: 'ALICE', includeExact: false, includeBoss: false });
  const localNames = [{ name: 'Alice Local', original: 'Alice Local', timestamp: 1, source: 'interactive' }];
  const { harness, app, syncStore } = createHarness({ confirmedNames: localNames });
  const scope = {
    ...clone(syncStore.scope),
    publicVersion: 1,
    cursor: 'pv_1',
    baseHashes: { [original.businessKey]: original.contentHash },
  };
  const plans = await harness.planStage5GMixedMerge(BINDING, scope, snapshot, { id: 'local_fixture', items: [] });
  assert.equal(plans.ordinaryPlan.counts.upserts, 1);
  const result = harness.commitStage5GMixedPlan(BINDING, scope, plans);
  assert.equal(result.counts.conflicts, 0);
  assert.equal(app.enhancedExtractor.data.confirmedNames.some(item => item.name === 'ALICE'), true);
});

test('Stage5G rejects ordinary tombstones before any local write', async () => {
  const snapshot = await mixedSnapshot({ includeExact: false, includeBoss: false });
  const invalid = {
    ...snapshot,
    tombstones: [{ approvedVersion: 2, businessKey: snapshot.records[0].businessKey, dataType: 'playable_name', identity: { name: '小明' } }],
  };
  const { harness } = createHarness();
  assert.throws(
    () => harness.splitStage5GPublicSnapshot(invalid),
    error => error.code === 'ORDINARY_DELETE_REQUIRES_STAGE6',
  );
});

test('Stage5G combined commit rolls back confirmed names when boss persistence fails', async () => {
  const snapshot = await mixedSnapshot({ includeExact: false });
  const { harness, app, syncStore, bindingStore, initialScope } = createHarness({ bossSaveFailure: true });
  const plans = await harness.planStage5GMixedMerge(BINDING, initialScope, snapshot, { id: 'local_fixture', items: [] });
  assert.throws(
    () => harness.commitStage5GMixedPlan(BINDING, initialScope, plans),
    error => error.code === 'BOSS_MEMORY_PERSIST_FAILED',
  );
  assert.deepEqual(app.enhancedExtractor.data.confirmedNames, []);
  assert.deepEqual(app.bossMemory, []);
  assert.equal(syncStore.scope.publicVersion, 0);
  assert.equal(bindingStore.value.local_fixture, 0);
});
