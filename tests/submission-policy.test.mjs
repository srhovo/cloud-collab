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

const RAW_BASE = Object.freeze({
  schemaVersion: 1,
  payloadSchemaVersion: 1,
  submissionId: 'sub_01JABCDEF0123456789XYZABCD',
  deviceId: 'dev_01JABCDEF0123456789XYZABCD',
  groupId: 'group_fixture',
  libraryId: 'lib_receive_fixture',
  bossId: null,
  dataType: 'exact_price',
  operation: 'upsert',
  origin: 'user',
  clientCreatedAt: 1784376000000,
  businessKey: 'bk_v1_ja06mv-cCqOze_uiSIK4YjKoixcrewF-NIQXmAiTyTQ',
  contentHash: 'ch_v1_8cLsoYwgKnmAXyDgNjXMkDLlD2t2JjdXyKrde_KhoqA',
  idempotencyKey: '',
  payload: { serviceName: ' 测试服务A ', settleType: 'ROUND', unitPrice: 110 },
  clientContext: { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 },
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function withComputed(input = RAW_BASE) {
  const value = clone(input);
  value.idempotencyKey = buildIdempotencyKey(value.deviceId, value.submissionId);
  return value;
}
function expectCode(code, fn) {
  assert.throws(fn, error => error instanceof SubmissionValidationError && error.code === code);
}

const BASE = Object.freeze(withComputed());

test('accepts the frozen atomic envelope and normalizes exact price payload', () => {
  const value = normalizeSubmission(BASE);
  assert.equal(value.groupId, 'group_fixture');
  assert.equal(value.origin, 'user');
  assert.deepEqual(value.payload, { serviceName: '测试服务A', settleType: 'round', unitPrice: 110 });
  assert.deepEqual(value.clientContext, { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 });
});

test('server hashes match the Stage3B synthetic public fixture', () => {
  const result = computeSubmissionHashes(BASE);
  assert.equal(result.businessKey, 'bk_v1_ja06mv-cCqOze_uiSIK4YjKoixcrewF-NIQXmAiTyTQ');
  assert.equal(result.contentHash, 'ch_v1_8cLsoYwgKnmAXyDgNjXMkDLlD2t2JjdXyKrde_KhoqA');
});

test('idempotency key follows frozen ik_v1 canonical object rule', () => {
  const first = buildIdempotencyKey(BASE.deviceId, BASE.submissionId);
  const second = buildIdempotencyKey(BASE.deviceId, BASE.submissionId);
  const other = buildIdempotencyKey('dev_01JABCDEF0123456789XYZABCE', BASE.submissionId);
  assert.match(first, /^ik_v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test('rejects unknown top-level and recursively forbidden fields', () => {
  expectCode('FORBIDDEN_FIELD', () => normalizeSubmission({ ...clone(BASE), note: '私人备注' }));
  const nested = clone(BASE);
  nested.payload.usageCount = 9;
  expectCode('FORBIDDEN_FIELD', () => normalizeSubmission(nested));
  expectCode('INVALID_SUBMISSION_FIELDS', () => normalizeSubmission({ ...clone(BASE), harmlessExtra: true }));
});

test('requires all frozen envelope versions, origin, hashes and client context', () => {
  const missing = clone(BASE);
  delete missing.payloadSchemaVersion;
  expectCode('INVALID_SUBMISSION_FIELDS', () => normalizeSubmission(missing));
  const badOrigin = { ...clone(BASE), origin: 'import' };
  expectCode('INVALID_SUBMISSION_ORIGIN', () => normalizeSubmission(badOrigin));
  const badContext = clone(BASE);
  badContext.clientContext.queueSchemaVersion = 2;
  expectCode('UNSUPPORTED_QUEUE_SCHEMA', () => normalizeSubmission(badContext));
});

test('requires Crockford ULID device and submission identifiers', () => {
  const badDevice = { ...clone(BASE), deviceId: 'dev_01JABCDEF0123456789XYZABCI' };
  expectCode('INVALID_DEVICE_ID', () => normalizeSubmission(badDevice));
  const badSubmission = { ...clone(BASE), submissionId: 'sub_short' };
  expectCode('INVALID_SUBMISSION_ID', () => normalizeSubmission(badSubmission));
});

test('rejects delete, non-price data and non-null boss scope', () => {
  expectCode('SENSITIVE_OPERATION_REQUIRES_REVIEW', () => normalizeSubmission({ ...clone(BASE), operation: 'delete' }));
  expectCode('UNSUPPORTED_DATA_TYPE', () => normalizeSubmission({ ...clone(BASE), dataType: 'playable_name' }));
  expectCode('INVALID_BOSS_SCOPE', () => normalizeSubmission({ ...clone(BASE), bossId: 'boss_01JABCDEF0123456789XYZABCD' }));
});

test('rejects invalid price precision and control characters', () => {
  const precision = clone(BASE);
  precision.payload.unitPrice = 1.2345;
  expectCode('INVALID_UNIT_PRICE', () => normalizeSubmission(precision));
  const control = clone(BASE);
  control.payload.serviceName = '测试\u0000服务';
  expectCode('INVALID_SERVICE_NAME', () => normalizeSubmission(control));
});

test('rejects client hash and idempotency mismatches after server recomputation', () => {
  expectCode('BUSINESS_KEY_MISMATCH', () => normalizeSubmission({ ...clone(BASE), businessKey: 'bk_v1_0000000000000000000000000000000000000000000' }));
  expectCode('CONTENT_HASH_MISMATCH', () => normalizeSubmission({ ...clone(BASE), contentHash: 'ch_v1_0000000000000000000000000000000000000000000' }));
  expectCode('IDEMPOTENCY_KEY_MISMATCH', () => normalizeSubmission({ ...clone(BASE), idempotencyKey: 'ik_v1_0000000000000000000000000000000000000000000' }));
});

test('enforces the frozen 16KB request limit', () => {
  assert.equal(MAX_SUBMISSION_BYTES, 16 * 1024);
  assert.ok(assertSubmissionRequestBytes(BASE) < MAX_SUBMISSION_BYTES);
  expectCode('SUBMISSION_TOO_LARGE', () => assertSubmissionRequestBytes('x'.repeat(MAX_SUBMISSION_BYTES + 1)));
});

test('new content waits for a second device and cannot mutate public data', () => {
  const decision = evaluateExactPriceCandidate({ submission: BASE, matchingDistinctDeviceCount: 1 });
  assert.equal(decision.decision, 'waiting_confirmation');
  assert.equal(decision.publicMutationAllowed, false);
  assert.equal(decision.autoApprovalEnabled, false);
});

test('two distinct devices become eligible but automatic approval remains disabled', () => {
  const decision = evaluateExactPriceCandidate({ submission: BASE, matchingDistinctDeviceCount: 2 });
  assert.equal(decision.decision, 'eligible_auto_approval');
  assert.equal(decision.reason, 'two_devices_match');
  assert.equal(decision.publicMutationAllowed, false);
  assert.equal(decision.autoApprovalEnabled, false);
});

test('trusted device is only an eligibility input and cannot publish in Stage4A', () => {
  const decision = evaluateExactPriceCandidate({ submission: BASE, trustedDevice: true });
  assert.equal(decision.decision, 'eligible_auto_approval');
  assert.equal(decision.reason, 'trusted_device');
  assert.equal(decision.publicMutationAllowed, false);
  assert.equal(decision.autoApprovalEnabled, false);
});

test('same public content is a no-op', () => {
  const decision = evaluateExactPriceCandidate({
    submission: BASE,
    existingRecord: { businessKey: BASE.businessKey, contentHash: BASE.contentHash },
  });
  assert.equal(decision.decision, 'duplicate_noop');
});

test('any conflicting public value or candidate requires review without a hard ±10% rule', () => {
  const publicConflict = evaluateExactPriceCandidate({
    submission: BASE,
    existingRecord: { businessKey: BASE.businessKey, contentHash: 'ch_v1_0000000000000000000000000000000000000000000' },
    matchingDistinctDeviceCount: 2,
  });
  assert.equal(publicConflict.decision, 'pending_review');
  assert.equal(publicConflict.reason, 'public_value_conflict');
  assert.equal(Object.hasOwn(publicConflict, 'changeRatio'), false);

  const candidateConflict = evaluateExactPriceCandidate({ submission: BASE, conflictingCandidateCount: 1 });
  assert.equal(candidateConflict.decision, 'pending_review');
  assert.equal(candidateConflict.reason, 'candidate_conflict');
});
