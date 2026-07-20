import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class ReleaseReadinessAuditError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'ReleaseReadinessAuditError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new ReleaseReadinessAuditError(code, message, details);
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function read(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) fail('RELEASE_FILE_MISSING', `缺少文件：${relativePath}`);
  return fs.readFileSync(absolutePath);
}

function json(root, relativePath) {
  try {
    return JSON.parse(read(root, relativePath).toString('utf8'));
  } catch (error) {
    if (error instanceof ReleaseReadinessAuditError) throw error;
    fail('RELEASE_JSON_INVALID', `JSON无效：${relativePath}`);
  }
}

function envMap(text) {
  const result = new Map();
  String(text).split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const split = line.indexOf('=');
    if (split < 1) fail('RELEASE_ENV_LINE_INVALID', '环境示例行无效', { line: index + 1 });
    const key = line.slice(0, split).trim();
    if (result.has(key)) fail('RELEASE_ENV_DUPLICATE_KEY', '环境示例变量重复', { key });
    result.set(key, line.slice(split + 1).trim());
  });
  return result;
}

function auditEnv(values) {
  const gates = [...values.entries()].filter(([key]) => key.endsWith('_ENABLED'));
  if (gates.length < 8) fail('RELEASE_ENV_GATES_INCOMPLETE', '默认关闭能力数量异常');
  const open = gates.filter(([, value]) => value !== '0').map(([key]) => key);
  if (open.length) fail('RELEASE_ENV_GATE_OPEN', '存在默认开启的能力', { keys: open });
  const privateSuffix = /(?:_KEY|_SECRET|_PASSWORD|_SALT|_USERNAME)$/;
  const populated = [...values.entries()]
    .filter(([key, value]) => privateSuffix.test(key) && value !== '')
    .map(([key]) => key);
  if (populated.length) fail('RELEASE_ENV_PRIVATE_VALUE_PRESENT', '环境示例包含非空私密值', { keys: populated });
  for (const key of ['CLOUD_COLLAB_API_BASE', 'CLOUD_ADMIN_PUBLIC_ORIGIN']) {
    if ((values.get(key) || '') !== '') fail('RELEASE_ENV_ENDPOINT_PINNED', '环境示例固定了临时来源', { key });
  }
  return Object.freeze({
    enabledGateCount: gates.length,
    allEnabledGatesDefaultOff: true,
    examplePrivateValuesEmpty: true,
    deploymentOriginUnpinned: true,
  });
}

function titleOf(html, version) {
  const match = String(html).match(/<title>([^<]+)<\/title>/i);
  if (!match || !match[1].includes(version)) {
    fail('RELEASE_TITLE_VERSION_MISMATCH', '候选标题版本不匹配', { version, title: match?.[1] || null });
  }
  return match[1];
}

function ledgerOf(value) {
  if (!value || value.schemaVersion !== 1) fail('RELEASE_LEDGER_INVALID', '证据账本无效');
  for (const key of ['stableVersion', 'currentCompatibleCandidateVersion', 'recommendedCandidateVersionFromPlan']) {
    if (!/^\d+\.\d+\.\d+$/.test(String(value[key] || ''))) fail('RELEASE_LEDGER_VERSION_INVALID', '证据账本版本无效', { key });
  }
  const stable = value.stableArtifact;
  if (!stable || stable.source !== 'external_frozen_baseline'
      || stable.filename !== '码单器8.2.25_现.html'
      || stable.title !== `码单器${value.stableVersion}`
      || !/^[a-f0-9]{64}$/.test(String(stable.sha256 || ''))
      || !Number.isSafeInteger(stable.bytes) || stable.bytes <= 0) {
    fail('RELEASE_STABLE_METADATA_INVALID', '外部冻结稳定基线元数据无效');
  }
  if (value.evidence?.automated?.stage7dWorkflowConclusion !== 'success'
      || value.evidence?.automated?.coreAndBrowserRegression !== 'passed') {
    fail('RELEASE_AUTOMATED_EVIDENCE_FAILED', '自动化证据未通过');
  }
  const policy = value.releasePolicy || {};
  if (policy.stableBaselineMustRemainUnchanged !== true
      || policy.allPreviewCapabilitiesDefaultOff !== true
      || policy.candidateVersionRequiresOwnerDecision !== true
      || policy.promotionRequiresSeparateOwnerAuthorization !== true
      || policy.productionWriteEnablementIncluded !== false) {
    fail('RELEASE_POLICY_INVALID', '发布策略边界无效');
  }
  return value;
}

function blockersOf(ledger) {
  const blockers = [];
  if (ledger.candidateVersionDecision === null) blockers.push('candidate_version_owner_decision');
  if (ledger.evidence.realDevice.finalCleanSnapshotAndTombstoneRerun !== 'passed') {
    blockers.push('real_device_final_rerun_exception_acceptance');
  }
  if (!ledger.evidence.cleanup.exactDeletionCountsRecorded
      || !ledger.evidence.cleanup.independentZeroCountEvidenceRecorded) {
    blockers.push('cleanup_exact_evidence_missing');
  }
  if (ledger.evidence.temporaryResources.status !== 'verified_destroyed') {
    blockers.push('temporary_resource_teardown_verification');
  }
  return Object.freeze(blockers);
}

export function auditReleaseRepository({ root } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const pkg = json(repositoryRoot, 'package.json');
  const ledger = ledgerOf(json(repositoryRoot, 'release/release-closure-ledger-v1.json'));
  const manifest = json(repositoryRoot, 'dist/build-manifest.json');
  const candidate = read(repositoryRoot, 'dist/index.html');
  const buildScript = read(repositoryRoot, 'scripts/build-stage6b-compatible.mjs').toString('utf8');

  if (pkg.scripts?.build !== 'node scripts/build-stage6b-compatible.mjs') {
    fail('RELEASE_BUILD_ENTRY_INVALID', '候选构建入口发生变化');
  }
  if (manifest.version !== ledger.currentCompatibleCandidateVersion || manifest.output !== 'dist/index.html') {
    fail('RELEASE_MANIFEST_VERSION_INVALID', '构建清单版本无效');
  }
  const candidateSha256 = digest(candidate);
  if (manifest.sha256 !== candidateSha256 || manifest.bytes !== candidate.length) {
    fail('RELEASE_MANIFEST_HASH_MISMATCH', '构建清单与候选摘要不一致');
  }
  if (!buildScript.includes(`manifest.version = '${ledger.currentCompatibleCandidateVersion}'`)
      || !buildScript.includes('compatibleShellRetained = true')) {
    fail('RELEASE_BUILD_CONTRACT_INVALID', '兼容候选构建契约无效');
  }
  if (ledger.stableArtifact.sha256 === candidateSha256) {
    fail('RELEASE_STABLE_CANDIDATE_IDENTICAL', '稳定基线与候选摘要相同');
  }

  const blockers = blockersOf(ledger);
  return Object.freeze({
    schemaVersion: 1,
    status: blockers.length ? 'decision_required' : 'promotion_authorization_required',
    stable: Object.freeze({
      version: ledger.stableVersion,
      ...ledger.stableArtifact,
      verifiedBy: 'frozen_external_metadata',
      repositoryCopyExpected: false,
      unchangedByAudit: true,
    }),
    candidate: Object.freeze({
      currentCompatibleVersion: ledger.currentCompatibleCandidateVersion,
      recommendedVersionFromPlan: ledger.recommendedCandidateVersionFromPlan,
      ownerDecision: ledger.candidateVersionDecision,
      title: titleOf(candidate.toString('utf8'), ledger.currentCompatibleCandidateVersion),
      sha256: candidateSha256,
      bytes: candidate.length,
      buildManifestVerified: true,
    }),
    environment: auditEnv(envMap(read(repositoryRoot, '.env.example').toString('utf8'))),
    evidence: ledger.evidence,
    blockers,
    boundaries: Object.freeze({
      filesModifiedByAudit: 0,
      deploymentsPerformed: 0,
      blobMutationsPerformed: 0,
      productionWriteEnablementIncluded: false,
      promotionPerformed: false,
    }),
  });
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = auditReleaseRepository({ root });
  fs.writeFileSync(path.join(root, 'dist', 'release-readiness-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
