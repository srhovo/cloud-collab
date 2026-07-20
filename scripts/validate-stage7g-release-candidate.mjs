import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateVersion = '8.2.30';
const previousVersion = '8.2.28';
const candidateFilename = `码单器${candidateVersion}_候选.html`;

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`阶段7G缺少文件：${relativePath}`);
  return fs.readFileSync(absolutePath);
}

function json(relativePath) {
  return JSON.parse(read(relativePath).toString('utf8'));
}

const output = read('dist/index.html');
const candidate = read(`release/candidates/${candidateFilename}`);
const buildManifest = json('dist/build-manifest.json');
const releaseManifest = json('release/final-release-manifest-v1.json');
const ledger = json('release/release-closure-ledger-v1.json');
const digest = crypto.createHash('sha256').update(candidate).digest('hex');

if (!output.equals(candidate)) throw new Error('阶段7G候选单文件与dist/index.html不一致');
if (candidate.includes(Buffer.from(previousVersion))) throw new Error('阶段7G候选仍包含8.2.28版本号');
const html = candidate.toString('utf8');
if (!html.includes(`<title>码单器${candidateVersion}（公共协作完整候选版）</title>`)) {
  throw new Error('阶段7G候选标题无效');
}
if (!html.includes(`const APP_VERSION = '${candidateVersion}';`)) {
  throw new Error('阶段7G候选APP_VERSION无效');
}
if (buildManifest.version !== candidateVersion
    || buildManifest.stage !== '7G-release-candidate'
    || buildManifest.releaseCandidate !== true
    || buildManifest.stablePromotionPerformed !== false
    || buildManifest.formalPublicWritesEnabled !== false
    || buildManifest.candidateFilename !== candidateFilename
    || buildManifest.sha256 !== digest
    || buildManifest.bytes !== candidate.length) {
  throw new Error('阶段7G构建清单无效');
}
if (releaseManifest.releaseState !== 'candidate_ready_not_promoted'
    || releaseManifest.candidate?.version !== candidateVersion
    || releaseManifest.candidate?.filename !== candidateFilename
    || releaseManifest.candidate?.sha256 !== digest
    || releaseManifest.candidate?.bytes !== candidate.length
    || releaseManifest.stable?.version !== '8.2.25'
    || releaseManifest.stable?.unchanged !== true
    || releaseManifest.stable?.promotionPerformed !== false
    || releaseManifest.boundaries?.stablePromotionAuthorized !== false
    || releaseManifest.boundaries?.stablePromotionPerformed !== false
    || releaseManifest.boundaries?.productionWriteEnablementIncluded !== false
    || releaseManifest.nextRequiredAuthorization !== 'stable_promotion_requires_separate_owner_authorization') {
  throw new Error('阶段7G最终发布清单无效');
}
if (ledger.candidateVersionDecision !== candidateVersion
    || ledger.currentCompatibleCandidateVersion !== candidateVersion
    || ledger.evidence?.cleanup?.exactEvidenceMissingExceptionAcceptedByOwner !== true
    || ledger.evidence?.realDevice?.finalCleanSnapshotAndTombstoneRerunExceptionAcceptedByOwner !== true) {
  throw new Error('阶段7G发布决策证据无效');
}
if (ledger.stableArtifact?.sha256 === digest) throw new Error('阶段7G候选与稳定基线摘要意外相同');

const env = read('.env.example').toString('utf8');
const enabledLines = env.split(/\r?\n/).filter(line => /^[A-Z0-9_]+_ENABLED=/.test(line.trim()));
if (enabledLines.length < 8 || enabledLines.some(line => !line.trim().endsWith('=0'))) {
  throw new Error('阶段7G存在默认开启的预览或写入能力');
}

console.log(JSON.stringify({
  status: 'candidate_ready_not_promoted',
  version: candidateVersion,
  filename: candidateFilename,
  sha256: digest,
  bytes: candidate.length,
  stableVersion: releaseManifest.stable.version,
  stablePromotionPerformed: false,
}, null, 2));
