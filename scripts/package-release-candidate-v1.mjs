import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditReleaseRepository } from './release-readiness-audit-v1.mjs';

export class ReleasePackageError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'ReleasePackageError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new ReleasePackageError(code, message, details);
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readJson(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) fail('PACKAGE_FILE_MISSING', `缺少文件：${relativePath}`);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch {
    fail('PACKAGE_JSON_INVALID', `JSON无效：${relativePath}`);
  }
}

function titleOf(html, version) {
  const match = String(html).match(/<title>([^<]+)<\/title>/i);
  if (!match || !match[1].includes(version)) {
    fail('PACKAGE_TITLE_VERSION_MISMATCH', '候选标题版本不匹配', { version, title: match?.[1] || null });
  }
  return match[1];
}

export function packageReleaseCandidate({ root, outputDirectory } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const outputRoot = path.resolve(outputDirectory || path.join(repositoryRoot, 'release-output'));
  const ledger = readJson(repositoryRoot, 'release/release-closure-ledger-v1.json');
  const buildManifest = readJson(repositoryRoot, 'dist/build-manifest.json');
  const candidateBytes = fs.readFileSync(path.join(repositoryRoot, 'dist', 'index.html'));
  const audit = auditReleaseRepository({ root: repositoryRoot });

  if (audit.status !== 'promotion_authorization_required' || audit.blockers.length !== 0) {
    fail('PACKAGE_RELEASE_NOT_READY', '发布审计尚未允许候选打包', { status: audit.status, blockers: audit.blockers });
  }
  if (ledger.releasePolicy?.candidatePackagingAuthorized !== true
      || ledger.releasePolicy?.stablePromotionAuthorized !== false
      || ledger.releasePolicy?.stablePromotionPerformed !== false) {
    fail('PACKAGE_AUTHORIZATION_INVALID', '候选打包或稳定晋升授权边界无效');
  }

  const version = ledger.candidateVersionDecision;
  if (!version || version !== ledger.currentCompatibleCandidateVersion || buildManifest.version !== version) {
    fail('PACKAGE_VERSION_MISMATCH', '候选版本、构建清单与项目负责人决策不一致');
  }

  const sha256 = digest(candidateBytes);
  if (buildManifest.sha256 !== sha256 || buildManifest.bytes !== candidateBytes.length) {
    fail('PACKAGE_BUILD_MANIFEST_MISMATCH', '候选文件与构建清单摘要不一致');
  }

  const candidateFilename = `码单器${version}_候选.html`;
  const manifestFilename = `最终发布清单_${version}.json`;
  const auditFilename = `发布审计_${version}.json`;
  const candidateTitle = titleOf(candidateBytes.toString('utf8'), version);

  const finalManifest = Object.freeze({
    schemaVersion: 1,
    kind: 'candidate_release_package',
    releaseStatus: 'candidate_packaged_not_promoted',
    stable: Object.freeze({
      version: ledger.stableVersion,
      filename: ledger.stableArtifact.filename,
      title: ledger.stableArtifact.title,
      sha256: ledger.stableArtifact.sha256,
      bytes: ledger.stableArtifact.bytes,
      unchanged: true,
      promotionAuthorized: false,
      promotionPerformed: false,
    }),
    candidate: Object.freeze({
      version,
      filename: candidateFilename,
      title: candidateTitle,
      sha256,
      bytes: candidateBytes.length,
      buildOutput: buildManifest.output,
      buildManifestVerified: true,
      packagingAuthorized: true,
    }),
    decisions: Object.freeze({
      candidateVersionApprovedByOwner: true,
      candidateVersionDecisionRecordedAt: ledger.candidateVersionDecisionRecordedAt,
      finalCleanSnapshotAndTombstoneRerunWaiverAcceptedByOwner:
        ledger.evidence.realDevice.finalCleanSnapshotAndTombstoneRerunExceptionAcceptedByOwner === true,
      cleanupExactEvidenceWaiverAcceptedByOwner:
        ledger.evidence.cleanup.exactEvidenceWaiverAcceptedByOwner === true,
      cleanupExactDeletionCountsRecorded: ledger.evidence.cleanup.exactDeletionCountsRecorded,
      cleanupIndependentZeroCountEvidenceRecorded: ledger.evidence.cleanup.independentZeroCountEvidenceRecorded,
      stablePromotionAuthorized: false,
      stablePromotionPerformed: false,
      productionWriteEnablementAuthorized: false,
    }),
    verification: Object.freeze({
      releaseAuditStatus: audit.status,
      releaseAuditBlockers: audit.blockers,
      allPreviewCapabilitiesDefaultOff: audit.environment.allEnabledGatesDefaultOff,
      examplePrivateValuesEmpty: audit.environment.examplePrivateValuesEmpty,
      deploymentOriginUnpinned: audit.environment.deploymentOriginUnpinned,
      coreAndBrowserRegression: ledger.evidence.automated.coreAndBrowserRegression,
    }),
    artifactFiles: Object.freeze([candidateFilename, manifestFilename, auditFilename]),
    nextStep: 'separate_owner_authorization_required_for_stable_promotion',
  });

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, candidateFilename), candidateBytes);
  fs.writeFileSync(path.join(outputRoot, manifestFilename), `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outputRoot, auditFilename), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');

  return Object.freeze({
    outputDirectory: outputRoot,
    candidateFilename,
    manifestFilename,
    auditFilename,
    candidateSha256: sha256,
    candidateBytes: candidateBytes.length,
    finalManifest,
  });
}

function run() {
  const result = packageReleaseCandidate();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
