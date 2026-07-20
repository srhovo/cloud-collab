import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditReleaseRepository } from './release-readiness-audit-v1.mjs';

export const PUBLIC_CANDIDATE_FILES = Object.freeze([
  'index.html',
  'build-manifest.json',
  'pages-release.json',
]);

export const PUBLIC_CANDIDATE_CHANNELS = Object.freeze([
  'edgeone-primary',
  'github-pages-backup',
]);

const CANDIDATE_VERSION = '8.2.31';
const CANDIDATE_TITLE = '码单器8.2.31（公共协作发布候选版）';
const FINAL_RELEASE_MANIFEST = 'release/最终发布清单_8.2.31.json';
const ALLOWED_OUTPUT_DIRECTORIES = new Set(['.edgeone-artifact', '.pages-artifact']);

export class PublicCandidateArtifactError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'PublicCandidateArtifactError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new PublicCandidateArtifactError(code, message, details);
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readJson(absolutePath, label) {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch {
    fail('PUBLIC_CANDIDATE_JSON_INVALID', `${label}JSON无效`, { absolutePath });
  }
}

function repositoryCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function checkedCommit(value) {
  const commit = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    fail('PUBLIC_CANDIDATE_COMMIT_INVALID', '必须提供40位Git提交SHA');
  }
  return commit;
}

function safeOutputDirectory(root, outputDirectory) {
  const repositoryRoot = path.resolve(root);
  const target = path.resolve(outputDirectory || path.join(repositoryRoot, '.pages-artifact'));
  const relative = path.relative(repositoryRoot, target);
  if (!ALLOWED_OUTPUT_DIRECTORIES.has(relative)) {
    fail('PUBLIC_CANDIDATE_OUTPUT_UNSAFE', '公开产物目录必须是仓库根目录下的.pages-artifact或.edgeone-artifact', {
      relative,
    });
  }
  return target;
}

function assertReleaseBoundary(releaseAudit, finalManifest) {
  if (releaseAudit.status !== 'promotion_authorization_required' || releaseAudit.blockers.length !== 0) {
    fail('PUBLIC_CANDIDATE_RELEASE_NOT_READY', '发布证据未闭环，拒绝生成公开候选产物', {
      status: releaseAudit.status,
      blockers: releaseAudit.blockers,
    });
  }
  if (releaseAudit.boundaries?.promotionPerformed !== false
      || releaseAudit.boundaries?.productionWriteEnablementIncluded !== false) {
    fail('PUBLIC_CANDIDATE_BOUNDARY_INVALID', '审计边界不允许生成候选预演产物');
  }
  if (finalManifest.releaseStatus !== 'candidate_packaged_not_promoted'
      || finalManifest.candidate?.version !== CANDIDATE_VERSION
      || finalManifest.stable?.version !== '8.2.25'
      || finalManifest.stable?.promotionAuthorized !== false
      || finalManifest.stable?.promotionPerformed !== false
      || finalManifest.decisions?.stablePromotionAuthorized !== false
      || finalManifest.decisions?.stablePromotionPerformed !== false
      || finalManifest.decisions?.productionWriteEnablementAuthorized !== false
      || finalManifest.verification?.releaseAuditStatus !== 'promotion_authorization_required'
      || !Array.isArray(finalManifest.verification?.releaseAuditBlockers)
      || finalManifest.verification.releaseAuditBlockers.length !== 0) {
    fail('PUBLIC_CANDIDATE_FINAL_MANIFEST_INVALID', '阶段7J最终发布清单边界无效');
  }
}

export function preparePublicCandidate({
  root,
  outputDirectory,
  commitSha,
  channel = 'github-pages-backup',
} = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const target = safeOutputDirectory(repositoryRoot, outputDirectory);
  const sourceCommit = checkedCommit(commitSha || process.env.GITHUB_SHA || repositoryCommit(repositoryRoot));
  if (!PUBLIC_CANDIDATE_CHANNELS.includes(channel)) {
    fail('PUBLIC_CANDIDATE_CHANNEL_INVALID', '公开候选通道无效', { channel });
  }

  const releaseAudit = auditReleaseRepository({ root: repositoryRoot });
  const finalManifestPath = path.join(repositoryRoot, FINAL_RELEASE_MANIFEST);
  const finalManifest = readJson(finalManifestPath, '阶段7J最终发布清单');
  assertReleaseBoundary(releaseAudit, finalManifest);

  const indexPath = path.join(repositoryRoot, 'dist', 'index.html');
  const buildManifestPath = path.join(repositoryRoot, 'dist', 'build-manifest.json');
  const indexBytes = fs.readFileSync(indexPath);
  const buildManifestBytes = fs.readFileSync(buildManifestPath);
  const buildManifest = readJson(buildManifestPath, '构建清单');
  const indexSha256 = digest(indexBytes);
  const indexText = indexBytes.toString('utf8');

  if (buildManifest.version !== CANDIDATE_VERSION
      || buildManifest.output !== 'dist/index.html'
      || buildManifest.sha256 !== indexSha256
      || buildManifest.bytes !== indexBytes.length) {
    fail('PUBLIC_CANDIDATE_BUILD_MANIFEST_MISMATCH', '构建清单与8.2.31候选HTML不一致');
  }
  if (finalManifest.candidate.sha256 !== indexSha256
      || finalManifest.candidate.bytes !== indexBytes.length
      || finalManifest.candidate.title !== CANDIDATE_TITLE) {
    fail('PUBLIC_CANDIDATE_FROZEN_HASH_MISMATCH', '重新构建的候选与阶段7J冻结候选不一致', {
      expectedSha256: finalManifest.candidate.sha256,
      actualSha256: indexSha256,
      expectedBytes: finalManifest.candidate.bytes,
      actualBytes: indexBytes.length,
    });
  }
  if (!indexText.includes(`<title>${CANDIDATE_TITLE}</title>`)
      || !indexText.includes("const APP_VERSION = '8.2.31';")) {
    fail('PUBLIC_CANDIDATE_HTML_IDENTITY_INVALID', '候选HTML标题或APP_VERSION无效');
  }

  const release = {
    schemaVersion: 1,
    kind: 'candidate_preview_deployment',
    deploymentStatus: 'candidate_preview_not_stable',
    channel,
    sourceCommit,
    sourceReleaseManifest: FINAL_RELEASE_MANIFEST,
    candidate: {
      version: finalManifest.candidate.version,
      title: finalManifest.candidate.title,
      sha256: indexSha256,
      bytes: indexBytes.length,
    },
    stable: {
      version: finalManifest.stable.version,
      promotionAuthorized: false,
      promotionPerformed: false,
    },
    buildManifestSha256: digest(buildManifestBytes),
    allPreviewCapabilitiesDefaultOff: finalManifest.verification.allPreviewCapabilitiesDefaultOff === true,
    productionWriteEnablementIncluded: false,
    generatedAt: buildManifest.generatedAt,
  };

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(indexPath, path.join(target, 'index.html'));
  fs.copyFileSync(buildManifestPath, path.join(target, 'build-manifest.json'));
  fs.writeFileSync(path.join(target, 'pages-release.json'), `${JSON.stringify(release, null, 2)}\n`, 'utf8');

  const files = fs.readdirSync(target).sort();
  if (JSON.stringify(files) !== JSON.stringify([...PUBLIC_CANDIDATE_FILES].sort())) {
    fail('PUBLIC_CANDIDATE_SCOPE_INVALID', '公开候选产物文件范围无效', { files });
  }
  for (const filename of files) {
    const stat = fs.lstatSync(path.join(target, filename));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('PUBLIC_CANDIDATE_FILE_TYPE_INVALID', '公开候选产物必须是普通文件', { filename });
    }
  }

  return Object.freeze({
    outputDirectory: target,
    files: Object.freeze(files),
    release: Object.freeze(release),
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = preparePublicCandidate({
    root,
    outputDirectory: argumentValue('--output'),
    commitSha: argumentValue('--commit'),
    channel: argumentValue('--channel') || 'github-pages-backup',
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
