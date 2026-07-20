import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_READINESS_AUDIT_VERSION = 1;

export class ReleaseReadinessAuditError extends Error {
  constructor(code, message, details = null) {
    super(message || code || '发布收口审计失败');
    this.name = 'ReleaseReadinessAuditError';
    this.code = code || 'RELEASE_READINESS_AUDIT_ERROR';
    this.details = details;
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readRequired(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new ReleaseReadinessAuditError(
      'RELEASE_FILE_MISSING',
      `发布收口缺少文件：${relativePath}`,
      { relativePath },
    );
  }
  return fs.readFileSync(absolutePath);
}

function readJson(root, relativePath) {
  let value;
  try {
    value = JSON.parse(readRequired(root, relativePath).toString('utf8'));
  } catch (error) {
    if (error instanceof ReleaseReadinessAuditError) throw error;
    throw new ReleaseReadinessAuditError(
      'RELEASE_JSON_INVALID',
      `发布收口JSON无效：${relativePath}`,
      { relativePath, reason: String(error?.message || error) },
    );
  }
  return value;
}

function parseEnvExample(text) {
  const values = new Map();
  const lines = String(text || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) {
      throw new ReleaseReadinessAuditError(
        'RELEASE_ENV_LINE_INVALID',
        '.env.example包含无效配置行',
        { lineNumber: index + 1 },
      );
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (values.has(key)) {
      throw new ReleaseReadinessAuditError(
        'RELEASE_ENV_DUPLICATE_KEY',
        '.env.example包含重复变量',
        { key },
      );
    }
    values.set(key, value);
  }
  return values;
}

function assertEnvironmentDefaults(envValues) {
  const enabledEntries = [...envValues.entries()].filter(([key]) => key.endsWith('_ENABLED'));
  if (enabledEntries.length < 8) {
    throw new ReleaseReadinessAuditError(
      'RELEASE_ENV_GATES_INCOMPLETE',
      '发布收口识别到的默认关闭能力数量异常',
      { enabledCount: enabledEntries.length },
    );
  }
  const enabledViolations = enabledEntries.filter(([, value]) => value !== '0');
  if (enabledViolations.length > 0) {
    throw new ReleaseReadinessAuditError(
      'RELEASE_ENV_GATE_OPEN',
      '存在未默认关闭的预览或写入能力',
      { keys: enabledViolations.map(([key]) => key) },
    );
  }

  const secretPattern = /(?:_KEY|_SECRET|_PASSWORD|_SALT|_USERNAME)$/;
  const secretViolations = [...envValues.entries()]
    .filter(([key, value]) => secretPattern.test(key) && value !== '')
    .map(([key]) => key);
  if (secretViolations.length > 0) {
    throw new ReleaseReadinessAuditError(
      'RELEASE_ENV_SECRET_PRESENT',
      '.env.example不得包含凭据或盐值',
      { keys: secretViolations },
    );
  }

  for (const key of ['CLOUD_COLLAB_API_BASE', 'CLOUD_ADMIN_PUBLIC_ORIGIN']) {
    if ((envValues.get(key) || '') !== '') {
      throw new ReleaseReadinessAuditError(
        'RELEASE_ENV_PUBLIC_ENDPOINT_PINNED',
        '发布收口前示例环境不得固定部署来源',
        { key },
      );
    }
  }

  return Object.freeze({
    enabledGateCount: enabledEntries.length,
    allEnabledGatesDefaultOff: true,
    exampleSecretsEmpty: true,
    deploymentOriginUnpinned: true,
  });
}

function assertTitle(html, version, label) {
  const titleMatch = String(html).match(/<title>([^<]+)<\/title>/i);
  if (!titleMatch || !titleMatch[1].includes(version)) {
    throw new ReleaseReadinessAuditError(
      'RELEASE_TITLE_VERSION_MISMATCH',
      `${label}标题版本不匹配`,
      { expectedVersion: version, actualTitle: titleMatch?.[1] || null },
    );
  }
  return titleMatch[1];
}

function normalizeLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || ledger.schemaVersion !== 1) {
    throw new ReleaseReadinessAuditError('RELEASE_LEDGER_INVALID', '发布证据账本结构无效');
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(ledger.stableVersion || ''))
      || !/^\d+\.\d+\.\d+$/.test(String(ledger.currentCompatibleCandidateVersion || ''))
      || !/^\d+\.\d+\.\d+$/.test(String(ledger.recommendedCandidateVersionFromPlan || ''))) {
    throw new ReleaseReadinessAuditError('RELEASE_LEDGER_VERSION_INVALID', '发布证据账本版本字段无效');
  }
  if (!ledger.evidence?.automated || !ledger.evidence?.realDevice
      || !ledger.evidence?.cleanup || !ledger.evidence?.temporaryResources
      || !ledger.releasePolicy) {
    throw new ReleaseReadinessAuditError('RELEASE_LEDGER_EVIDENCE_INVALID', '发布证据账本缺少必要分区');
  }
  if (ledger.evidence.automated.stage7dWorkflowConclusion !== 'success'
      || ledger.evidence.automated.coreAndBrowserRegression !== 'passed') {
    throw new ReleaseReadinessAuditError('RELEASE_AUTOMATED_EVIDENCE_FAILED', '发布自动化证据未通过');
  }
  if (ledger.releasePolicy.stableBaselineMustRemainUnchanged !== true
      || ledger.releasePolicy.allPreviewCapabilitiesDefaultOff !== true
      || ledger.releasePolicy.candidateVersionRequiresOwnerDecision !== true
      || ledger.releasePolicy.promotionRequiresSeparateOwnerAuthorization !== true
      || ledger.releasePolicy.productionWriteEnablementIncluded !== false) {
    throw new ReleaseReadinessAuditError('RELEASE_POLICY_INVALID', '发布策略边界无效');
  }
  return ledger;
}

function buildDecisionState(ledger) {
  const blockers = [];
  if (ledger.candidateVersionDecision === null) blockers.push('candidate_version_owner_decision');
  if (ledger.evidence.realDevice.finalCleanSnapshotAndTombstoneRerun !== 'passed') {
    blockers.push('real_device_final_rerun_exception_acceptance');
  }
  if (ledger.evidence.cleanup.exactDeletionCountsRecorded !== true
      || ledger.evidence.cleanup.independentZeroCountEvidenceRecorded !== true) {
    blockers.push('cleanup_exact_evidence_missing');
  }
  if (ledger.evidence.temporaryResources.status !== 'verified_destroyed') {
    blockers.push('temporary_resource_teardown_verification');
  }
  return Object.freeze(blockers);
}

export function auditReleaseRepository({ root } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const packageJson = readJson(repositoryRoot, 'package.json');
  const ledger = normalizeLedger(readJson(repositoryRoot, 'release/release-closure-ledger-v1.json'));
  const manifest = readJson(repositoryRoot, 'dist/build-manifest.json');
  const envValues = parseEnvExample(readRequired(repositoryRoot, '.env.example').toString('utf8'));
  const stableBytes = readRequired(repositoryRoot, `码单器${ledger.stableVersion}.html`);
  const candidateBytes = readRequired(repositoryRoot, 'dist/index.html');
  const buildScript = readRequired(repositoryRoot, 'scripts/build-stage6b-compatible.mjs').toString('utf8');

  if (packageJson.scripts?.build !== 'node scripts/build-stage6b-compatible.mjs') {
    throw new ReleaseReadinessAuditError('RELEASE_BUILD_ENTRY_INVALID', '发布候选构建入口发生未审计变化');
  }
  if (manifest.version !== ledger.currentCompatibleCandidateVersion
      || manifest.output !== 'dist/index.html') {
    throw new ReleaseReadinessAuditError(
      'RELEASE_MANIFEST_VERSION_INVALID',
      '构建清单与当前兼容候选版本不一致',
      { manifestVersion: manifest.version, expected: ledger.currentCompatibleCandidateVersion },
    );
  }
  if (manifest.sha256 !== sha256(candidateBytes) || manifest.bytes !== candidateBytes.length) {
    throw new ReleaseReadinessAuditError('RELEASE_MANIFEST_HASH_MISMATCH', '构建清单与候选文件摘要不一致');
  }
  if (!buildScript.includes(`manifest.version = '${ledger.currentCompatibleCandidateVersion}'`)
      || !buildScript.includes('compatibleShellRetained = true')) {
    throw new ReleaseReadinessAuditError('RELEASE_COMPATIBLE_BUILD_CONTRACT_INVALID', '兼容候选构建契约无效');
  }

  const stableTitle = assertTitle(stableBytes.toString('utf8'), ledger.stableVersion, '稳定基线');
  const candidateTitle = assertTitle(candidateBytes.toString('utf8'), ledger.currentCompatibleCandidateVersion, '当前兼容候选');
  const stableSha256 = sha256(stableBytes);
  const candidateSha256 = sha256(candidateBytes);
  if (stableSha256 === candidateSha256) {
    throw new ReleaseReadinessAuditError('RELEASE_STABLE_CANDIDATE_IDENTICAL', '稳定基线与云端候选不应为同一文件');
  }

  const environment = assertEnvironmentDefaults(envValues);
  const blockers = buildDecisionState(ledger);
  const status = blockers.length === 0 ? 'promotion_authorization_required' : 'decision_required';

  return Object.freeze({
    schemaVersion: RELEASE_READINESS_AUDIT_VERSION,
    status,
    stable: Object.freeze({
      version: ledger.stableVersion,
      title: stableTitle,
      sha256: stableSha256,
      bytes: stableBytes.length,
      unchangedByAudit: true,
    }),
    candidate: Object.freeze({
      currentCompatibleVersion: ledger.currentCompatibleCandidateVersion,
      recommendedVersionFromPlan: ledger.recommendedCandidateVersionFromPlan,
      ownerDecision: ledger.candidateVersionDecision,
      title: candidateTitle,
      sha256: candidateSha256,
      bytes: candidateBytes.length,
      buildManifestVerified: true,
    }),
    environment,
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

function runCli() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = auditReleaseRepository({ root });
  const outputPath = path.join(root, 'dist', 'release-readiness-audit.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
