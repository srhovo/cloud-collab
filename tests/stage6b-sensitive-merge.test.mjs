import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const DEVICE = 'dev_01JABCDEF0123456789XYZABCD';
const SUBMISSION = 'sub_01JABCDEF0123456789XYZABCD';

function load() {
  const context = {
    Buffer, TextEncoder, Uint8Array, Uint32Array, DataView, URL, AbortController,
    setTimeout, clearTimeout, crypto: webcrypto,
  };
  context.globalThis = context;
  for (const path of [
    'src/cloud_collab_snapshot_sync.js',
    'src/cloud_collab_submission_client.js',
    'src/cloud_collab_ordinary_types_client.js',
    'src/cloud_collab_sensitive_rules_client.js',
    'src/cloud_collab_sensitive_merge_client.js',
  ]) vm.runInNewContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
  return context;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function range(round = 12) {
  return {
    id: 'local-range', kind: 'rankRange', rangeLabel: '0-20星', alias: '低星', rankType: 'star',
    minStar: 0, maxStar: 20, namedRanks: [],
    prices: { normal: { round, hour: null }, carry: { round: null, hour: null }, starGuarantee: { round: null, hour: null } },
  };
}
async function remoteRecord(client, dataType, payload, version = 1) {
  const submission = await client.buildSensitiveSubmission({
    deviceId: DEVICE, submissionId: SUBMISSION, groupId: GROUP, libraryId: LIBRARY,
    dataType, payload, origin: 'user', clientCreatedAt: 0,
  });
  return { businessKey: submission.businessKey, contentHash: submission.contentHash, dataType, operation: 'upsert', approvedVersion: version, payload: plain(submission.payload) };
}

test('Stage6B merge adds new public rules and advances base hashes', async () => {
  const context = load();
  const remote = await remoteRecord(context.CloudCollabSensitiveRules, 'rank_range_rule', context.CloudCollabSensitiveMerge.rangePayload(range()));
  const plan = await context.CloudCollabSensitiveMerge.planSensitiveMerge({
    groupId: GROUP, libraryId: LIBRARY, records: [remote], rangeRules: [], baseHashes: {},
  });
  assert.equal(plan.counts.upserts, 1);
  assert.equal(plan.counts.conflicts, 0);
  assert.equal(plan.operations[0].action, 'upsert');
  assert.equal(plan.nextBaseHashes[remote.businessKey], remote.contentHash);
  const applied = await context.CloudCollabSensitiveMerge.applySensitiveMergePlan({
    groupId: GROUP, libraryId: LIBRARY, rangeRules: [], plan, now: 100,
  });
  assert.equal(applied.rangeRules.length, 1);
  assert.equal(applied.rangeRules[0].source, 'cloudPull');
  assert.equal(applied.rangeRules[0].prices.normal.round, 12);
});

test('Stage6B merge updates unchanged local baseline and preserves divergent local edits as conflicts', async () => {
  const context = load();
  const baseLocal = range(12);
  const baseRemote = await remoteRecord(context.CloudCollabSensitiveRules, 'rank_range_rule', context.CloudCollabSensitiveMerge.rangePayload(baseLocal));
  const changedRemote = await remoteRecord(context.CloudCollabSensitiveRules, 'rank_range_rule', context.CloudCollabSensitiveMerge.rangePayload(range(15)), 2);

  const cleanPlan = await context.CloudCollabSensitiveMerge.planSensitiveMerge({
    groupId: GROUP, libraryId: LIBRARY,
    records: [changedRemote], rangeRules: [baseLocal], baseHashes: { [baseRemote.businessKey]: baseRemote.contentHash },
  });
  assert.equal(cleanPlan.counts.upserts, 1);
  assert.equal(cleanPlan.counts.conflicts, 0);

  const divergent = range(13);
  const conflictPlan = await context.CloudCollabSensitiveMerge.planSensitiveMerge({
    groupId: GROUP, libraryId: LIBRARY,
    records: [changedRemote], rangeRules: [divergent], baseHashes: { [baseRemote.businessKey]: baseRemote.contentHash },
  });
  assert.equal(conflictPlan.counts.upserts, 0);
  assert.equal(conflictPlan.counts.conflicts, 1);
  assert.equal(conflictPlan.conflicts[0].businessKey, baseRemote.businessKey);
});

test('Stage6B tombstone deletes only an unchanged tracked local item', async () => {
  const context = load();
  const gift = { id: 'gift-1', serviceType: '红包', mode: 'fixed', unitPrice: 66 };
  const remote = await remoteRecord(context.CloudCollabSensitiveRules, 'gift_rule', context.CloudCollabSensitiveMerge.giftPayload(gift));
  const tombstone = { businessKey: remote.businessKey, contentHash: `ch_v1_${'T'.repeat(43)}`, dataType: 'gift_rule', operation: 'delete', approvedVersion: 2 };

  const plan = await context.CloudCollabSensitiveMerge.planSensitiveMerge({
    groupId: GROUP, libraryId: LIBRARY, tombstones: [tombstone], gifts: [gift],
    baseHashes: { [remote.businessKey]: remote.contentHash },
  });
  assert.equal(plan.counts.deletes, 1);
  const applied = await context.CloudCollabSensitiveMerge.applySensitiveMergePlan({
    groupId: GROUP, libraryId: LIBRARY, gifts: [gift], plan,
  });
  assert.equal(applied.gifts.length, 0);

  const untracked = await context.CloudCollabSensitiveMerge.planSensitiveMerge({
    groupId: GROUP, libraryId: LIBRARY, tombstones: [tombstone], gifts: [gift], baseHashes: {},
  });
  assert.equal(untracked.counts.preserveLocal, 1);
  assert.equal(untracked.operations.length, 0);
});

test('Stage6B playable and boss tombstones can remove tracked shared records', async () => {
  const context = load();
  const name = { name: '小明' };
  const boss = { name: '老板甲', paiDan: '直属A', discount: 0.97 };
  const nameSubmission = await context.CloudCollabOrdinaryTypes.buildOrdinarySubmission({
    deviceId: DEVICE, submissionId: SUBMISSION, groupId: GROUP, libraryId: LIBRARY,
    dataType: 'playable_name', payload: { name: name.name }, origin: 'user', clientCreatedAt: 0,
  });
  const bossSubmission = await context.CloudCollabOrdinaryTypes.buildOrdinarySubmission({
    deviceId: DEVICE, submissionId: 'sub_01JABCDEF0123456789XYZABCE', groupId: GROUP, libraryId: LIBRARY,
    dataType: 'boss_profile', payload: { bossName: boss.name, paiDan: boss.paiDan, discount: boss.discount }, origin: 'user', clientCreatedAt: 0,
  });
  const tombstones = [
    { businessKey: nameSubmission.businessKey, contentHash: `ch_v1_${'N'.repeat(43)}`, dataType: 'playable_name', operation: 'delete', approvedVersion: 2 },
    { businessKey: bossSubmission.businessKey, contentHash: `ch_v1_${'B'.repeat(43)}`, dataType: 'boss_profile', operation: 'delete', approvedVersion: 3 },
  ];
  const plan = await context.CloudCollabSensitiveMerge.planSensitiveMerge({
    groupId: GROUP, libraryId: LIBRARY, tombstones, confirmedNames: [name], bossMemory: [boss],
    baseHashes: { [nameSubmission.businessKey]: nameSubmission.contentHash, [bossSubmission.businessKey]: bossSubmission.contentHash },
  });
  assert.equal(plan.counts.deletes, 2);
  const applied = await context.CloudCollabSensitiveMerge.applySensitiveMergePlan({
    groupId: GROUP, libraryId: LIBRARY, confirmedNames: [name], bossMemory: [boss], plan,
  });
  assert.equal(applied.confirmedNames.length, 0);
  assert.equal(applied.bossMemory.length, 0);
});
