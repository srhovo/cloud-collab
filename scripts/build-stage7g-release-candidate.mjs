import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceVersion = '8.2.28';
const candidateVersion = '8.2.30';
const candidateFilename = `码单器${candidateVersion}_候选.html`;

await import(`${new URL('./build-stage6b-compatible.mjs', import.meta.url).href}?stage7g=${Date.now()}`);

const outputPath = path.join(root, 'dist', 'index.html');
const manifestPath = path.join(root, 'dist', 'build-manifest.json');
const ledgerPath = path.join(root, 'release', 'release-closure-ledger-v1.json');
const candidatePath = path.join(root, 'release', 'candidates', candidateFilename);
const releaseManifestPath = path.join(root, 'release', 'final-release-manifest-v1.json');

const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
if (ledger.candidateVersionDecision !== candidateVersion
    || ledger.currentCompatibleCandidateVersion !== candidateVersion) {
  throw new Error('阶段7G候选版本决策与构建目标不一致');
}
if (ledger.evidence?.realDevice?.finalCleanSnapshotAndTombstoneRerunExceptionAcceptedByOwner !== true) {
  throw new Error('阶段7G缺少最终人工重跑豁免授权');
}
if (ledger.evidence?.cleanup?.exactEvidenceMissingExceptionAcceptedByOwner !== true) {
  throw new Error('阶段7G缺少清理精确证据豁免授权');
}
if (ledger.releasePolicy?.stablePromotionAuthorized !== false
    || ledger.releasePolicy?.productionWriteEnablementIncluded !== false) {
  throw new Error('阶段7G发布边界不允许晋升稳定版或开启正式写入');
}

let html = fs.readFileSync(outputPath, 'utf8');
const sourceVersionCount = html.split(sourceVersion).length - 1;
if (sourceVersionCount < 2) {
  throw new Error(`阶段7G版本迁移锚点数量不足：${sourceVersionCount}`);
}
html = html.split(sourceVersion).join(candidateVersion);

const candidateTitle = `<title>码单器${candidateVersion}（公共协作完整候选版）</title>`;
html = html.replace(
  `<title>码单器${candidateVersion}（公共协作候选派发客户端）</title>`,
  candidateTitle,
);

if (!html.includes(candidateTitle)) throw new Error('阶段7G候选标题迁移失败');
if (!html.includes(`const APP_VERSION = '${candidateVersion}';`)) {
  throw new Error('阶段7G候选APP_VERSION迁移失败');
}
if (html.includes(sourceVersion)) throw new Error('阶段7G候选仍残留旧候选版本号');

const candidateBytes = Buffer.from(html, 'utf8');
const candidateSha256 = crypto.createHash('sha256').update(candidateBytes).digest('hex');
fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
fs.writeFileSync(outputPath, candidateBytes);
fs.writeFileSync(candidatePath, candidateBytes);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = candidateVersion;
manifest.stage = '7G-release-candidate';
manifest.output = 'dist/index.html';
manifest.candidateFilename = candidateFilename;
manifest.previousCompatibleCandidateVersion = sourceVersion;
manifest.releaseCandidate = true;
manifest.stablePromotionPerformed = false;
manifest.formalPublicWritesEnabled = false;
manifest.sha256 = candidateSha256;
manifest.bytes = candidateBytes.length;
manifest.generatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const finalReleaseManifest = {
  schemaVersion: 1,
  releaseState: 'candidate_ready_not_promoted',
  generatedAt: ledger.candidateVersionDecisionRecordedAt,
  generationBasis: 'owner_decision_and_reproducible_ci_build',
  sourceCommit: null,
  stable: {
    version: ledger.stableVersion,
    ...ledger.stableArtifact,
    unchanged: true,
    promotionPerformed: false,
  },
  candidate: {
    version: candidateVersion,
    filename: candidateFilename,
    repositoryPath: `release/candidates/${candidateFilename}`,
    buildOutput: 'dist/index.html',
    title: `码单器${candidateVersion}（公共协作完整候选版）`,
    sha256: candidateSha256,
    bytes: candidateBytes.length,
    singleFileHtml: true,
  },
  evidence: {
    candidateVersionDecision: {
      accepted: true,
      recordedAt: ledger.candidateVersionDecisionRecordedAt,
      source: ledger.candidateVersionDecisionSource,
    },
    finalManualRerunWaiver: {
      accepted: ledger.evidence.realDevice.finalCleanSnapshotAndTombstoneRerunExceptionAcceptedByOwner === true,
      state: ledger.evidence.realDevice.finalCleanSnapshotAndTombstoneRerun,
      recordedAt: ledger.evidence.realDevice.exceptionAcceptanceRecordedAt,
    },
    cleanupExactEvidenceWaiver: {
      accepted: ledger.evidence.cleanup.exactEvidenceMissingExceptionAcceptedByOwner === true,
      exactDeletionCountsRecorded: ledger.evidence.cleanup.exactDeletionCountsRecorded,
      independentZeroCountEvidenceRecorded: ledger.evidence.cleanup.independentZeroCountEvidenceRecorded,
      recordedAt: ledger.evidence.cleanup.exceptionAcceptanceRecordedAt,
    },
    temporaryResources: ledger.evidence.temporaryResources,
  },
  boundaries: {
    stablePromotionAuthorized: false,
    stablePromotionPerformed: false,
    productionWriteEnablementIncluded: false,
    edgeOneDeploymentPerformed: false,
    blobMutationsPerformed: false,
  },
  nextRequiredAuthorization: 'stable_promotion_requires_separate_owner_authorization',
};
fs.writeFileSync(releaseManifestPath, `${JSON.stringify(finalReleaseManifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  version: candidateVersion,
  candidateFilename,
  sha256: candidateSha256,
  bytes: candidateBytes.length,
  releaseState: finalReleaseManifest.releaseState,
}, null, 2));
