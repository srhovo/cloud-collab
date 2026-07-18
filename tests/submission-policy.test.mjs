import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SUBMISSION_BYTES,
  SubmissionValidationError,
  assertSubmissionRequestBytes,
  buildIdempotencyKey,
  computeSubmissionHashes,
  evaluateExactPriceCandidate,
  normalizeSubmission,
} from '../src/server/submission_policy_v1.js';

const BASE = Object.freeze({
  schemaVersion: 1,
  submissionId: 'sub_01JABCDEF0123456789XYZABCD',
  deviceId: 'dev_01JABCDEF0123456789XYZABCD',
  groupId: 'group_fixture',
  libraryId: 'lib_receive_fixture',
  dataType: 'exact_price',
  operation: 'upsert',
  basePublicVersion: 3,
  clientCreatedAt: 1784376000000,
  payload: { serviceName: ' 测试服务A ', settleType: 'ROUND', unitPrice: 110 },
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function expectCode(code, fn) {
  assert.throws(fn, error => error instanceof SubmissionValidationError && error.code === code);
}

test('normalizes the strict exact-price submission whitelist', () => {
  const value = normalizeSubmission(BASE);
  assert.equal(value.groupId, 'group_fixture');
  assert.deepEqual(value.payload, { serviceName: '测试服务A', settleType: 'round', unitPrice: 110 });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.payload), true);
});

test('hashes match the Stage3B synthetic public fixture', () => {
  const result = computeSubmissionHashes(BASE);
  assert.equal(result.businessKey, 'bk_v1_ja06mv-cCqOze_uiSIK4YjKoixcrewF-NIQXmAiTyTQ');
  assert.equal(result.contentHash, 'ch_v1_8cLsoYwgKnmAXyDgNjXMkDLlD2t2JjdXyKrde_KhoqA');
});

test('idempotency key is deterministic and device-scoped', () => {
  const first = buildIdempotencyKey(BASE.deviceId, BASE.submissionId);
  const second = buildIdempotencyKey(BASE.deviceId, BASE.submissionId);
  const other = buildIdempotencyKey('dev_01JABCDEF0123456789XYZABCE', BASE.submissionId);
  assert.match(first, /^idem_v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test('rejects unknown top-level fields and private data', () => {
  const input = { ...clone(BASE), note: '私人备注' };
  expectCode('INVALID_SUBMISSION_FIELDS', () => normalizeSubmission(input));
});

test('rejects unknown payload fields', () => {
  const input = clone(BASE);
  input.payload.usageCount = 9;
  expectCode('INVALID_EXACT_PRICE_FIELDS', () => normalizeSubmission(input));
});

test('rejects delete and non-price data during Stage4A', () => {
  const deleted = { ...clone(BASE), operation: 'delete' };
  expectCode('SENSITIVE_OPERATION_REQUIRES_REVIEW', () => normalizeSubmission(deleted));
  const name = { ...clone(BASE), dataType: 'playable_name' };
  expectCode('UNSUPPORTED_DATA_TYPE', () => normalizeSubmission(name));
});

test('rejects invalid price precision and control characters', () => {
  const precision = clone(BASE);
  precision.payload.unitPrice = 1.2345;
  expectCode('INVALID_UNIT_PRICE', () => normalizeSubmission(precision));
  const control = clone(BASE);
  control.payload.serviceName = '测试\u0000服务';
  expectCode('INVALID_SERVICE_NAME', () => normalizeSubmission(control));
});

test('enforces the 64KB request limit', () => {
  assert.ok(assertSubmissionRequestBytes(BASE) < MAX_SUBMISSION_BYTES);
  expectCode('SUBMISSION_TOO_LARGE', () => assertSubmissionRequestBytes('x'.repeat(MAX_SUBMISSION_BYTES + 1)));
});

test('new price waits for a second device and cannot mutate public data', () => {
  const decision = evaluateExactPriceCandidate({ submission: BASE, matchingDeviceCount: 1 });
  assert.equal(decision.decision, 'waiting_confirmation');
  assert.equal(decision.publicMutationAllowed, false);
  assert.equal(decision.autoApprovalEnabled, false);
});

test('two matching devices become eligible but automatic approval remains disabled', () => {
  const decision = evaluateExactPriceCandidate({ submission: BASE, matchingDeviceCount: 2 });
  assert.equal(decision.decision, 'eligible_auto_approval');
  assert.equal(decision.reason, 'two_devices_match');
  assert.equal(decision.publicMutationAllowed, false);
  assert.equal(decision.autoApprovalEnabled, false);
});

test('same public content is a no-op', () => {
  const hashes = computeSubmissionHashes(BASE);
  const decision = evaluateExactPriceCandidate({
    submission: BASE,
    existingRecord: { businessKey: hashes.businessKey, contentHash: hashes.contentHash, unitPrice: 110 },
  });
  assert.equal(decision.decision, 'duplicate_noop');
});

test('price changes over 10 percent or conflicting candidates require review', () => {
  const hashes = computeSubmissionHashes(BASE);
  const over = evaluateExactPriceCandidate({
    submission: { ...clone(BASE), payload: { ...BASE.payload, unitPrice: 120 } },
    existingRecord: { businessKey: hashes.businessKey, contentHash: 'ch_v1_0000000000000000000000000000000000000000000', unitPrice: 100 },
    matchingDeviceCount: 2,
  });
  assert.equal(over.decision, 'pending_review');
  assert.equal(over.reason, 'price_change_over_10_percent');

  const conflict = evaluateExactPriceCandidate({
    submission: BASE,
    conflictingCandidateCount: 1,
  });
  assert.equal(conflict.decision, 'pending_review');
  assert.equal(conflict.reason, 'conflict_detected');
});
