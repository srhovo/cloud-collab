import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeOrdinarySubmissionHashes,
  evaluateOrdinaryCandidate,
  normalizeOrdinarySubmission,
} from '../src/server/ordinary_types_policy_v1.js';
import {
  computeSensitiveSubmissionHashes,
  evaluateSensitiveCandidate,
  normalizeGiftRulePayload,
  normalizeRankRangeRulePayload,
  normalizeSensitiveSubmission,
  normalizeSurchargeRulePayload,
  readSensitiveRulesPreviewConfig,
} from '../src/server/sensitive_rules_policy_v1.js';

const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';
const GROUP = 'group_fixture';
const LIBRARY = 'lib_receive_fixture';
const BK = `bk_v1_${'A'.repeat(43)}`;
const CH = `ch_v1_${'A'.repeat(43)}`;
const IK = `ik_v1_${'A'.repeat(43)}`;

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
    clientCreatedAt: 1_784_560_000_000,
    businessKey: BK,
    contentHash: CH,
    idempotencyKey: IK,
    payload,
    clientContext: {
      appVersion: '8.2.30-stage6a',
      projectionSpecVersion: 1,
      queueSchemaVersion: 1,
    },
    ...overrides,
  };
}

function complete(raw) {
  const computed = computeSensitiveSubmissionHashes(raw);
  return {
    ...raw,
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    idempotencyKey: computed.idempotencyKey,
  };
}

function rangePayload(overrides = {}) {
  return {
    rangeLabel: '0-20星',
    alias: '王者低星',
    rankType: 'star',
    minStar: 0,
    maxStar: 20,
    namedRanks: [],
    prices: {
      normal: { round: 12, hour: null },
      carry: { round: 18, hour: 66 },
      starGuarantee: { round: null, hour: 88 },
    },
    ...overrides,
  };
}

function surchargePayload(overrides = {}) {
  return {
    name: '甜蜜单',
    keywords: ['甜蜜单', '甜蜜', '甜蜜单'],
    prices: { round: 5, hour: 20 },
    enabled: true,
    ...overrides,
  };
}

function bossDraft(discount, paiDan = '直属A', overrides = {}) {
  return draft('boss_profile', { bossName: '老板甲', paiDan, discount }, overrides);
}

function existingFrom(submission, payload = submission.payload, contentHash = submission.contentHash) {
  return {
    businessKey: submission.businessKey,
    contentHash,
    dataType: submission.dataType,
    bossId: submission.bossId,
    payload,
  };
}

test('Stage6A gate is closed by default and hard-locks Blob plus fixture scope', () => {
  assert.throws(() => readSensitiveRulesPreviewConfig({}), error => error.code === 'SENSITIVE_RULES_PREVIEW_DISABLED');
  const env = {
    CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED: '1',
    CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID: GROUP,
    CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID: LIBRARY,
  };
  assert.equal(readSensitiveRulesPreviewConfig(env).enabled, true);
  assert.throws(
    () => readSensitiveRulesPreviewConfig({ ...env, CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME: 'formal-public' }),
    error => error.code === 'SENSITIVE_RULES_SCOPE_INVALID',
  );
});

test('Stage6A rank ranges mirror the actual 8.2 model and keep identity separate from prices', () => {
  const normalized = normalizeRankRangeRulePayload(rangePayload({
    rangeLabel: '  ０－２０星  ',
    alias: '  王者   低星 ',
  }));
  assert.equal(normalized.rangeLabel, '0-20星');
  assert.equal(normalized.alias, '王者 低星');
  assert.deepEqual(normalized.namedRanks, []);

  const first = computeSensitiveSubmissionHashes(draft('rank_range_rule', rangePayload()));
  const same = computeSensitiveSubmissionHashes(draft('rank_range_rule', rangePayload(), {
    submissionId: 'sub_01JABCDEF0123456789XYZABCE',
    deviceId: DEVICE_B,
  }));
  const changedPrice = computeSensitiveSubmissionHashes(draft('rank_range_rule', rangePayload({
    prices: {
      normal: { round: 13, hour: null },
      carry: { round: 18, hour: 66 },
      starGuarantee: { round: null, hour: 88 },
    },
  })));
  assert.equal(first.businessKey, same.businessKey);
  assert.equal(first.contentHash, same.contentHash);
  assert.notEqual(first.idempotencyKey, same.idempotencyKey);
  assert.equal(first.businessKey, changedPrice.businessKey);
  assert.notEqual(first.contentHash, changedPrice.contentHash);
});

test('Stage6A named ranges, boundaries, and price matrices fail closed', () => {
  const named = normalizeRankRangeRulePayload(rangePayload({
    rangeLabel: '大师宗师',
    rankType: 'namedTier',
    minStar: null,
    maxStar: null,
    namedRanks: ['大师', ' 宗师 ', '大师'],
  }));
  assert.deepEqual(named.namedRanks, ['大师', '宗师']);
  for (const payload of [
    rangePayload({ minStar: 21, maxStar: 20 }),
    rangePayload({ namedRanks: ['王者'] }),
    rangePayload({ rankType: 'namedTier', minStar: 0, maxStar: null, namedRanks: ['大师'] }),
    rangePayload({ rankType: 'namedTier', minStar: null, maxStar: null, namedRanks: [] }),
    rangePayload({ prices: {
      normal: { round: null, hour: null },
      carry: { round: null, hour: null },
      starGuarantee: { round: null, hour: null },
    } }),
  ]) assert.throws(() => normalizeRankRangeRulePayload(payload));
});

test('Stage6A surcharge and gift payloads are strict public projections', () => {
  const surcharge = normalizeSurchargeRulePayload(surchargePayload({
    name: ' 甜蜜单 ',
    keywords: [' 甜蜜单 ', 'ＴＥＳＴ', 'test', '甜蜜'],
  }));
  assert.deepEqual(surcharge, {
    name: '甜蜜单',
    keywords: ['甜蜜单', 'TEST', '甜蜜'],
    prices: { round: 5, hour: 20 },
    enabled: true,
  });
  assert.deepEqual(normalizeGiftRulePayload({ serviceName: ' 红 包 ', mode: 'fixed', unitPrice: 66.6 }), {
    serviceName: '红 包', mode: 'fixed', unitPrice: 66.6,
  });
  assert.deepEqual(normalizeGiftRulePayload({ serviceName: '随机礼物', mode: 'variable', unitPrice: null }), {
    serviceName: '随机礼物', mode: 'variable', unitPrice: null,
  });
  assert.throws(() => normalizeGiftRulePayload({ serviceName: '红包', mode: 'fixed', unitPrice: null }));
  assert.throws(() => normalizeGiftRulePayload({ serviceName: '红包', mode: 'variable', unitPrice: 10 }));
  assert.throws(
    () => computeSensitiveSubmissionHashes(draft('surcharge_rule', { ...surchargePayload(), ruleId: 'local-only' })),
    error => error.code === 'FORBIDDEN_FIELD' || error.code === 'INVALID_SURCHARGE_RULE_FIELDS',
  );
});

test('Stage6A rejects private context, contacts, non-user origins, unsupported upserts, and oversized bodies', () => {
  assert.throws(
    () => computeSensitiveSubmissionHashes({ ...draft('gift_rule', { serviceName: '红包', mode: 'fixed', unitPrice: 10 }), note: 'private' }),
    error => error.code === 'FORBIDDEN_FIELD',
  );
  assert.throws(
    () => computeSensitiveSubmissionHashes(draft('surcharge_rule', surchargePayload({ keywords: ['微信:abcdef'] }))),
    error => error.code === 'SENSITIVE_CONTACT_INFO_FORBIDDEN',
  );
  for (const origin of ['system', 'import', 'migration', 'cloudPull', 'rollback']) {
    assert.throws(
      () => computeSensitiveSubmissionHashes(draft('gift_rule', { serviceName: '红包', mode: 'fixed', unitPrice: 10 }, { origin })),
      error => error.code === 'INVALID_SUBMISSION_ORIGIN',
    );
  }
  assert.throws(
    () => computeSensitiveSubmissionHashes(draft('exact_price', { serviceName: '测试', settleType: 'round', unitPrice: 10 })),
    error => error.code === 'UNSUPPORTED_SENSITIVE_DATA_TYPE',
  );
  assert.throws(
    () => computeSensitiveSubmissionHashes(draft('gift_rule', { serviceName: '甲'.repeat(20_000), mode: 'fixed', unitPrice: 10 })),
    error => error.code === 'SUBMISSION_TOO_LARGE',
  );
});

test('Stage6A rule upserts always stay pending review regardless of trust or device count', () => {
  const submissions = [
    complete(draft('rank_range_rule', rangePayload())),
    complete(draft('surcharge_rule', surchargePayload())),
    complete(draft('gift_rule', { serviceName: '红包', mode: 'fixed', unitPrice: 66 })),
  ];
  for (const submission of submissions) {
    const decision = evaluateSensitiveCandidate({
      submission,
      matchingDistinctDeviceCount: 99,
      trustedDevice: true,
      conflictingCandidateCount: 9,
    });
    assert.equal(decision.decision, 'pending_review');
    assert.equal(decision.autoApprovalEnabled, false);
    assert.equal(decision.publicMutationAllowed, false);
    assert.equal(decision.trustedDeviceBypassAllowed, false);
    assert.equal(decision.twoDeviceBypassAllowed, false);
  }
});

test('Stage6A explicit delete requires payload null and a matching public baseline', () => {
  const submission = complete(draft('exact_price', null, {
    operation: 'delete',
    businessKey: `bk_v1_${'D'.repeat(43)}`,
  }));
  const existing = {
    businessKey: submission.businessKey,
    contentHash: `ch_v1_${'E'.repeat(43)}`,
    dataType: 'exact_price',
    bossId: null,
    payload: { serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 88 },
  };
  const decision = evaluateSensitiveCandidate({ submission, existingRecord: existing, matchingDistinctDeviceCount: 8, trustedDevice: true });
  assert.equal(decision.decision, 'pending_review');
  assert.equal(decision.reason, 'explicit_delete_manual_review');
  assert.equal(decision.tombstoneRequested, true);
  assert.equal(decision.baselineContentHash, existing.contentHash);
  assert.throws(() => evaluateSensitiveCandidate({ submission }), error => error.code === 'DELETE_TARGET_NOT_FOUND');
  assert.throws(
    () => computeSensitiveSubmissionHashes({ ...submission, payload: {} }),
    error => error.code === 'DELETE_PAYLOAD_MUST_BE_NULL',
  );
});

test('Stage6A boss sensitive changes are manual-only while reasonable drops remain Stage5G ordinary', () => {
  const current = normalizeSensitiveSubmission(complete(bossDraft(0.97)));
  const existing = existingFrom(current);
  const sensitiveCases = [
    [complete(bossDraft(0.97, '直属B', { bossId: current.bossId })), 'boss_direct_report_change_sensitive'],
    [complete(bossDraft(0.98, '直属A', { bossId: current.bossId })), 'boss_discount_increase_sensitive'],
    [complete(bossDraft(0.90, '直属A', { bossId: current.bossId })), 'boss_discount_drop_abnormal'],
  ];
  for (const [submission, reason] of sensitiveCases) {
    const decision = evaluateSensitiveCandidate({ submission, existingRecord: existing, matchingDistinctDeviceCount: 100, trustedDevice: true });
    assert.equal(decision.decision, 'pending_review');
    assert.equal(decision.reason, reason);
    assert.equal(decision.autoApprovalEnabled, false);
  }
  const ordinaryDrop = complete(bossDraft(0.95, '直属A', { bossId: current.bossId }));
  assert.throws(
    () => evaluateSensitiveCandidate({ submission: ordinaryDrop, existingRecord: existing, matchingDistinctDeviceCount: 2 }),
    error => error.code === 'NOT_SENSITIVE_BOSS_CHANGE',
  );
});

test('Stage6A preserves Stage5G ordinary boss decisions', () => {
  const currentRaw = bossDraft(0.97);
  const currentHashes = computeOrdinarySubmissionHashes(currentRaw);
  const current = normalizeOrdinarySubmission({
    ...currentRaw,
    businessKey: currentHashes.businessKey,
    contentHash: currentHashes.contentHash,
    idempotencyKey: currentHashes.idempotencyKey,
  });
  const nextRaw = bossDraft(0.95, '直属A', {
    bossId: current.bossId,
    deviceId: DEVICE_B,
    submissionId: 'sub_01JABCDEF0123456789XYZABCE',
  });
  const nextHashes = computeOrdinarySubmissionHashes(nextRaw);
  const next = {
    ...nextRaw,
    businessKey: nextHashes.businessKey,
    contentHash: nextHashes.contentHash,
    idempotencyKey: nextHashes.idempotencyKey,
  };
  const decision = evaluateOrdinaryCandidate({ submission: next, existingRecord: existingFrom(current), matchingDistinctDeviceCount: 2 });
  assert.equal(decision.decision, 'eligible_auto_approval');
  assert.equal(decision.reason, 'two_devices_match');
});

test('Stage6A hashes detect tampering and bind idempotency to device plus submission ID', () => {
  const completed = complete(draft('gift_rule', { serviceName: '红包', mode: 'fixed', unitPrice: 66 }));
  assert.equal(normalizeSensitiveSubmission(completed).contentHash, completed.contentHash);
  assert.throws(
    () => normalizeSensitiveSubmission({ ...completed, contentHash: `ch_v1_${'Z'.repeat(43)}` }),
    error => error.code === 'CONTENT_HASH_MISMATCH',
  );
  const other = complete(draft('gift_rule', { serviceName: '红包', mode: 'fixed', unitPrice: 66 }, {
    deviceId: DEVICE_B,
    submissionId: 'sub_01JABCDEF0123456789XYZABCE',
  }));
  assert.equal(completed.businessKey, other.businessKey);
  assert.equal(completed.contentHash, other.contentHash);
  assert.notEqual(completed.idempotencyKey, other.idempotencyKey);
});
