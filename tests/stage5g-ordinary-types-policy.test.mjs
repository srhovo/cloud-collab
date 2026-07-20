import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeSubmissionHashes,
  evaluateExactPriceCandidate,
  normalizeSubmission,
} from '../src/server/submission_policy_v1.js';
import {
  MAX_AUTOMATIC_DISCOUNT_DROP,
  computeOrdinarySubmissionHashes,
  deriveBossId,
  evaluateOrdinaryCandidate,
  normalizeBossProfilePayload,
  normalizeOrdinarySubmission,
  normalizePlayableNamePayload,
  readOrdinaryTypesPreviewConfig,
} from '../src/server/ordinary_types_policy_v1.js';

const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const PLACEHOLDER_BUSINESS = `bk_v1_${'A'.repeat(43)}`;
const PLACEHOLDER_CONTENT = `ch_v1_${'A'.repeat(43)}`;
const PLACEHOLDER_IDEMPOTENCY = `ik_v1_${'A'.repeat(43)}`;

function draft(dataType, payload, overrides = {}) {
  return {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId: SUB_A,
    deviceId: DEVICE_A,
    groupId: GROUP,
    libraryId: LIBRARY,
    bossId: null,
    dataType,
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: 1_784_500_000_000,
    businessKey: PLACEHOLDER_BUSINESS,
    contentHash: PLACEHOLDER_CONTENT,
    idempotencyKey: PLACEHOLDER_IDEMPOTENCY,
    payload,
    clientContext: {
      appVersion: '8.2.28-stage5g',
      projectionSpecVersion: 1,
      queueSchemaVersion: 1,
    },
    ...overrides,
  };
}

function complete(raw) {
  const computed = computeOrdinarySubmissionHashes(raw);
  return {
    ...raw,
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    idempotencyKey: computed.idempotencyKey,
  };
}

function existingFrom(submission, payload = submission.payload) {
  return {
    businessKey: submission.businessKey,
    contentHash: submission.contentHash,
    dataType: submission.dataType,
    bossId: submission.bossId,
    payload,
  };
}

test('Stage5G gate defaults closed and hard-locks the synthetic store and scope', () => {
  assert.throws(
    () => readOrdinaryTypesPreviewConfig({}),
    error => error.code === 'ORDINARY_TYPES_PREVIEW_DISABLED',
  );
  const env = {
    CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED: '1',
    CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_ORDINARY_TYPES_ALLOWED_GROUP_ID: GROUP,
    CLOUD_ORDINARY_TYPES_ALLOWED_LIBRARY_ID: LIBRARY,
  };
  assert.equal(readOrdinaryTypesPreviewConfig(env).enabled, true);
  assert.throws(
    () => readOrdinaryTypesPreviewConfig({ ...env, CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME: 'formal-public' }),
    error => error.code === 'ORDINARY_TYPES_SCOPE_INVALID',
  );
});

test('Stage5G exact_price hashes, normalized submission, and decision remain byte-semantic compatible', () => {
  const raw = draft('exact_price', {
    serviceName: '鹅鸭杀',
    settleType: 'round',
    unitPrice: 88,
  });
  const oldComputed = computeSubmissionHashes(raw);
  const newComputed = computeOrdinarySubmissionHashes(raw);
  assert.deepEqual(newComputed, oldComputed);

  const completed = {
    ...raw,
    businessKey: oldComputed.businessKey,
    contentHash: oldComputed.contentHash,
    idempotencyKey: oldComputed.idempotencyKey,
  };
  assert.deepEqual(normalizeOrdinarySubmission(completed), normalizeSubmission(completed));
  assert.deepEqual(
    evaluateOrdinaryCandidate({ submission: completed, matchingDistinctDeviceCount: 2 }),
    evaluateExactPriceCandidate({ submission: completed, matchingDistinctDeviceCount: 2 }),
  );
});

test('Stage5G playable_name normalizes NFKC and spaces and deduplicates at group scope', () => {
  assert.deepEqual(normalizePlayableNamePayload({ name: '  ＡＢＣ   小明  ' }), { name: 'ABC 小明' });
  const first = computeOrdinarySubmissionHashes(draft('playable_name', { name: '  ＡＢＣ   小明  ' }));
  const second = computeOrdinarySubmissionHashes(draft('playable_name', { name: 'ABC 小明' }, {
    libraryId: 'lib_another_fixture',
    submissionId: 'sub_01JABCDEF0123456789XYZABCE',
    deviceId: DEVICE_B,
  }));
  assert.equal(first.businessKey, second.businessKey);
  assert.equal(first.contentHash, second.contentHash);
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
});

test('Stage5G playable_name rejects private fields, links, email, phones, control characters, and overlength names', () => {
  for (const payload of [
    { name: 'https://example.com' },
    { name: 'someone@example.com' },
    { name: '联系我13800138000' },
    { name: '微信:abcdef' },
    { name: '坏\u0000名字' },
    { name: '甲'.repeat(31) },
  ]) {
    assert.throws(() => normalizePlayableNamePayload(payload));
  }
  assert.throws(
    () => computeOrdinarySubmissionHashes({
      ...draft('playable_name', { name: '小明' }),
      note: 'private',
    }),
    error => error.code === 'FORBIDDEN_FIELD',
  );
  assert.throws(
    () => normalizePlayableNamePayload({ name: '小明', sourceOrderId: 'order-1' }),
    error => error.code === 'INVALID_PLAYABLE_NAME_FIELDS',
  );
});

test('Stage5G boss_profile derives stable server identity and group-wide hashes', () => {
  assert.deepEqual(normalizeBossProfilePayload({
    bossName: '  老  板 甲 ',
    paiDan: '  派 单 A ',
    discount: 0.9700,
  }), {
    bossName: '老 板 甲',
    paiDan: '派 单 A',
    discount: 0.97,
  });
  const raw = draft('boss_profile', { bossName: '老板甲', paiDan: '直属A', discount: 0.97 });
  const completed = complete(raw);
  const normalized = normalizeOrdinarySubmission(completed);
  assert.equal(normalized.bossId, deriveBossId(GROUP, '老板甲'));
  assert.equal(normalized.bossId.startsWith('boss_v1_'), true);

  const otherLibrary = computeOrdinarySubmissionHashes(draft('boss_profile', {
    bossName: '老板甲', paiDan: '直属A', discount: 0.97,
  }, { libraryId: 'lib_another_fixture' }));
  assert.equal(completed.businessKey, otherLibrary.businessKey);
  assert.equal(completed.contentHash, otherLibrary.contentHash);
});

test('Stage5G boss_profile rejects invalid discounts, contact info, extra fields, and identity mismatch', () => {
  for (const discount of [0.7999, 1.0001, Number.NaN, 0.912345]) {
    assert.throws(() => normalizeBossProfilePayload({ bossName: '老板甲', paiDan: '直属A', discount }));
  }
  assert.throws(() => normalizeBossProfilePayload({ bossName: '老板13800138000', paiDan: '', discount: 0.9 }));
  assert.throws(() => normalizeBossProfilePayload({ bossName: '老板甲', paiDan: '微信:abcdef', discount: 0.9 }));
  assert.throws(() => normalizeBossProfilePayload({ bossName: '老板甲', paiDan: '', discount: 0.9, localBossId: 'x' }));

  const wrongBossId = `boss_v1_${'B'.repeat(43)}`;
  assert.throws(
    () => computeOrdinarySubmissionHashes(draft('boss_profile', {
      bossName: '老板甲', paiDan: '直属A', discount: 0.97,
    }, { bossId: wrongBossId })),
    error => error.code === 'BOSS_IDENTITY_MISMATCH',
  );
});

test('Stage5G new playable and boss candidates use two-device or trusted-device approval without public mutation', () => {
  for (const raw of [
    draft('playable_name', { name: '小明' }),
    draft('boss_profile', { bossName: '老板甲', paiDan: '直属A', discount: 0.97 }),
  ]) {
    const submission = complete(raw);
    const waiting = evaluateOrdinaryCandidate({ submission });
    assert.equal(waiting.decision, 'waiting_confirmation');
    assert.equal(waiting.reason, 'second_device_required');
    assert.equal(waiting.publicMutationAllowed, false);
    assert.equal(waiting.autoApprovalEnabled, false);

    const twoDevices = evaluateOrdinaryCandidate({ submission, matchingDistinctDeviceCount: 2 });
    assert.equal(twoDevices.decision, 'eligible_auto_approval');
    assert.equal(twoDevices.reason, 'two_devices_match');

    const trusted = evaluateOrdinaryCandidate({ submission, trustedDevice: true });
    assert.equal(trusted.decision, 'eligible_auto_approval');
    assert.equal(trusted.reason, 'trusted_device');

    const conflicted = evaluateOrdinaryCandidate({ submission, conflictingCandidateCount: 1 });
    assert.equal(conflicted.decision, 'pending_review');
    assert.equal(conflicted.reason, 'candidate_conflict');
  }
});

test('Stage5G existing boss only treats same-direct-report reasonable discount drops as ordinary candidates', () => {
  const currentRaw = draft('boss_profile', { bossName: '老板甲', paiDan: '直属A', discount: 0.97 });
  const current = normalizeOrdinarySubmission(complete(currentRaw));
  const existing = existingFrom(current);

  const reasonable = complete(draft('boss_profile', {
    bossName: '老板甲', paiDan: '直属A', discount: 0.95,
  }, { bossId: current.bossId, submissionId: 'sub_01JABCDEF0123456789XYZABCE' }));
  const reasonableDecision = evaluateOrdinaryCandidate({
    submission: reasonable,
    existingRecord: existing,
    matchingDistinctDeviceCount: 2,
  });
  assert.equal(reasonableDecision.decision, 'eligible_auto_approval');

  const abnormal = complete(draft('boss_profile', {
    bossName: '老板甲', paiDan: '直属A', discount: 0.90,
  }, { bossId: current.bossId }));
  assert.equal(0.97 - 0.90 > MAX_AUTOMATIC_DISCOUNT_DROP, true);
  assert.equal(evaluateOrdinaryCandidate({ submission: abnormal, existingRecord: existing }).reason, 'boss_discount_drop_abnormal');

  const increased = complete(draft('boss_profile', {
    bossName: '老板甲', paiDan: '直属A', discount: 0.98,
  }, { bossId: current.bossId }));
  assert.equal(evaluateOrdinaryCandidate({ submission: increased, existingRecord: existing }).reason, 'boss_discount_increase_sensitive');

  const changedDirect = complete(draft('boss_profile', {
    bossName: '老板甲', paiDan: '直属B', discount: 0.95,
  }, { bossId: current.bossId }));
  assert.equal(evaluateOrdinaryCandidate({ submission: changedDirect, existingRecord: existing }).reason, 'boss_direct_report_change_sensitive');

  assert.equal(evaluateOrdinaryCandidate({ submission: current, existingRecord: existing }).decision, 'duplicate_noop');
});

test('Stage5G rejects system, import, migration, cloudPull and rollback origins', () => {
  for (const origin of ['system', 'import', 'migration', 'cloudPull', 'rollback']) {
    assert.throws(
      () => computeOrdinarySubmissionHashes(draft('playable_name', { name: '小明' }, { origin })),
      error => error.code === 'INVALID_SUBMISSION_ORIGIN',
    );
  }
});
