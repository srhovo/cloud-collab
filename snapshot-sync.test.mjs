import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { findPublicLibrary, cloneSnapshot } from '../edge-functions/api/_shared/catalog.js';

const source = fs.readFileSync(new URL('../src/cloud_collab_snapshot_sync.js', import.meta.url), 'utf8');
const context = { crypto: webcrypto, TextEncoder, Uint8Array, Buffer, btoa, console };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: 'cloud_collab_snapshot_sync.js' });
const Sync = context.CloudCollabSnapshotSync;
const snapshot = cloneSnapshot(findPublicLibrary('group_fixture', 'lib_receive_fixture'));

function local(serviceType, settleType, unitPrice) {
  return { id: `local_${serviceType}`, serviceType, settleType, unitPrice, usageCount: 1, createdAt: 1, updatedAt: 1, lastUsed: 1 };
}


test('pure JavaScript SHA-256 fallback matches frozen protocol hashes', async () => {
  const fallbackContext = { crypto: {}, TextEncoder, Uint8Array, DataView, Uint32Array, Buffer, btoa, console };
  fallbackContext.globalThis = fallbackContext;
  vm.runInNewContext(source, fallbackContext, { filename: 'cloud_collab_snapshot_sync.fallback.js' });
  const result = await fallbackContext.CloudCollabSnapshotSync.computeExactPriceHashes('group_fixture', 'lib_receive_fixture', { serviceName: '测试服务A', settleType: 'round', unitPrice: 110 });
  assert.equal(result.businessKey, 'bk_v1_ja06mv-cCqOze_uiSIK4YjKoixcrewF-NIQXmAiTyTQ');
  assert.equal(result.contentHash, 'ch_v1_8cLsoYwgKnmAXyDgNjXMkDLlD2t2JjdXyKrde_KhoqA');
});
test('fixture snapshot passes canonical SHA-256 verification', async () => {
  const verified = await Sync.verifySnapshot(snapshot);
  assert.equal(verified.publicVersion, 3);
  assert.equal(verified.records.length, 2);
});

test('fresh empty library receives both exact prices', async () => {
  const plan = await Sync.planExactPriceMerge({ snapshot, localItems: [], baseHashes: {} });
  assert.equal(plan.counts.upserts, 2);
  assert.equal(plan.counts.conflicts, 0);
  assert.equal(Object.keys(plan.nextBaseHashes).length, 2);
});

test('unchanged local base accepts remote update and new item', async () => {
  const oldA = await Sync.computeExactPriceHashes('group_fixture', 'lib_receive_fixture', { serviceName: '测试服务A', settleType: 'round', unitPrice: 100 });
  const plan = await Sync.planExactPriceMerge({
    snapshot,
    localItems: [local('测试服务A', 'round', 100)],
    baseHashes: { [oldA.businessKey]: oldA.contentHash },
  });
  assert.equal(plan.counts.upserts, 2);
  assert.equal(plan.counts.conflicts, 0);
});

test('both local and remote changed from base produces conflict without overwrite plan', async () => {
  const base = await Sync.computeExactPriceHashes('group_fixture', 'lib_receive_fixture', { serviceName: '测试服务A', settleType: 'round', unitPrice: 100 });
  const plan = await Sync.planExactPriceMerge({
    snapshot,
    localItems: [local('测试服务A', 'round', 90)],
    baseHashes: { [base.businessKey]: base.contentHash },
  });
  assert.equal(plan.counts.conflicts, 1);
  assert.equal(plan.counts.upserts, 1); // B remains safe to apply
  assert.equal(plan.conflicts[0].businessKey, base.businessKey);
});

test('remote unchanged from base preserves local modification', async () => {
  const remoteA = snapshot.records.find(item => item.payload.serviceName === '测试服务A');
  const plan = await Sync.planExactPriceMerge({
    snapshot,
    localItems: [local('测试服务A', 'round', 90), local('测试服务B', 'hour', 80)],
    baseHashes: { [remoteA.businessKey]: remoteA.contentHash },
  });
  assert.equal(plan.counts.preserveLocal, 1);
  assert.equal(plan.counts.conflicts, 0);
});

test('matching tombstone deletes only an unchanged local base', async () => {
  const hashes = await Sync.computeExactPriceHashes('group_fixture', 'lib_receive_fixture', { serviceName: '测试服务A', settleType: 'round', unitPrice: 100 });
  const deleteSnapshot = {
    schemaVersion: 1, payloadSchemaVersion: 1,
    groupId: 'group_fixture', libraryId: 'lib_receive_fixture',
    publicVersion: 4, snapshotVersion: 4, cursor: 'pv_4', generatedAt: '2026-07-18T00:00:04.000Z',
    records: [],
    tombstones: [{ approvedVersion: 4, businessKey: hashes.businessKey, dataType: 'exact_price', identity: { serviceName: '测试服务A', settleType: 'round' } }],
  };
  const plan = await Sync.planExactPriceMerge({ snapshot: deleteSnapshot, localItems: [local('测试服务A', 'round', 100)], baseHashes: { [hashes.businessKey]: hashes.contentHash } });
  assert.equal(plan.counts.deletes, 1);
  assert.equal(plan.counts.conflicts, 0);
});

test('tampered payload is rejected by hash verification', async () => {
  const tampered = structuredClone(snapshot);
  tampered.records[0].payload.unitPrice = 999;
  await assert.rejects(() => Sync.verifySnapshot(tampered), error => error.code === 'SNAPSHOT_HASH_MISMATCH');
});
