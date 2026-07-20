import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const source = read('src/server/sensitive_submission_acceptance_v1.js');
const tests = read('tests/stage6a-sensitive-acceptance.test.mjs');
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

check('Sensitive acceptance authenticates devices', source.includes('authenticateDevice') && source.includes('DEVICE_SCOPE_MISMATCH'));
check('Sensitive acceptance normalizes with Stage6A policy', source.includes('normalizeSensitiveSubmission(rawSubmission)'));
check('Sensitive acceptance uses immutable pending keys', source.includes('pendingSubmissionKey') && source.includes('putJSONOnlyIfNew'));
check('Sensitive acceptance hashes normalized request bodies', source.includes('buildSensitiveSubmissionRequestHash') && source.includes('canonicalize(submission)'));
check('Sensitive acceptance rejects idempotency body conflicts', source.includes('IDEMPOTENCY_CONFLICT') && source.includes('candidate.requestHash !== requestHash'));
check('Sensitive acceptance cannot mutate public data or auto approve', source.includes('publicMutationAllowed: false') && source.includes('autoApprovalEnabled: false'));
check('Sensitive acceptance requires pending review invariant', source.includes('SENSITIVE_MANUAL_REVIEW_INVARIANT_BROKEN') && source.includes("eligibility.decision !== 'pending_review'"));
check('Sensitive delete resolves public baseline', source.includes('resolveExistingRecord') && source.includes('resolvePublicBaseline'));
check('Acceptance tests cover replay and conflict', tests.includes('replays idempotently') && tests.includes('IDEMPOTENCY_CONFLICT'));
check('Acceptance tests cover device binding and baseline lookup', tests.includes('DEVICE_SCOPE_MISMATCH') && tests.includes('resolveExistingRecord'));
check('Acceptance source has no formal mutation helpers', !source.includes('publishPublic') && !source.includes('publicVersion'));
check('Acceptance source has no embedded credentials or browser persistence', !/(?:localStorage|sessionStorage)/.test(source)
  && !/(?:password|secret|token)\s*[:=]\s*['"][^'"]{12,}/i.test(source));

const failed = checks.filter(item => !item.ok);
const result = { stage: '6A-acceptance', total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks };
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test-results', '阶段6A_敏感候选不可变接收门禁.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ stage: result.stage, total: result.total, passed: result.passed, failed: result.failed }, null, 2));
process.exit(failed.length ? 1 : 0);
