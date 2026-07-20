import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditReleaseRepository } from './release-readiness-audit-v1.mjs';

export const PUBLIC_ARTIFACT_FILES = Object.freeze([
  'index.html',
  'build-manifest.json',
  'pages-release.json',
]);
export const PUBLIC_ARTIFACT_CHANNELS = Object.freeze([
  'github-pages-backup',
  'edgeone-primary',
]);
const PUBLIC_OUTPUT_DIRECTORIES = new Set(['.pages-artifact', '.edgeone-artifact']);

export class PagesArtifactError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'PagesArtifactError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new PagesArtifactError(code, message, details);
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readJson(absolutePath) {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch {
    fail('PAGES_JSON_INVALID', `JSON无效：${absolutePath}`);
  }
}

function safeOutputDirectory(root, outputDirectory) {
  const repositoryRoot = path.resolve(root);
  const target = path.resolve(outputDirectory || path.join(repositoryRoot, '.pages-artifact'));
  const relative = path.relative(repositoryRoot, target);
  if (!PUBLIC_OUTPUT_DIRECTORIES.has(relative)) {
    fail('PAGES_OUTPUT_UNSAFE', '公开产物目录必须是仓库内的.pages-artifact或.edgeone-artifact');
  }
  return target;
}

function assertCommitSha(commitSha) {
  if (!/^[a-f0-9]{40}$/i.test(String(commitSha || ''))) {
    fail('PAGES_COMMIT_INVALID', '必须提供40位Git提交SHA');
  }
  return String(commitSha).toLowerCase();
}

function repositoryCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function preparePagesArtifact({ root, outputDirectory, commitSha, channel = 'github-pages-backup' } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const target = safeOutputDirectory(repositoryRoot, outputDirectory);
  const sourceCommit = assertCommitSha(commitSha || process.env.GITHUB_SHA || repositoryCommit(repositoryRoot));
  if (!PUBLIC_ARTIFACT_CHANNELS.includes(channel)) {
    fail('PAGES_CHANNEL_INVALID', '公开产物通道无效', { channel });
  }
  const releaseAudit = auditReleaseRepository({ root: repositoryRoot });
  if (releaseAudit.status !== 'promotion_authorization_required' || releaseAudit.blockers.length !== 0) {
    fail('PAGES_RELEASE_NOT_READY', '发布证据尚未闭环，拒绝生成公开产物', {
      status: releaseAudit.status,
      blockers: releaseAudit.blockers,
    });
  }

  const dist = path.join(repositoryRoot, 'dist');
  const indexBytes = fs.readFileSync(path.join(dist, 'index.html'));
  const manifestBytes = fs.readFileSync(path.join(dist, 'build-manifest.json'));
  const manifest = readJson(path.join(dist, 'build-manifest.json'));
  if (manifest.sha256 !== digest(indexBytes) || manifest.bytes !== indexBytes.length) {
    fail('PAGES_BUILD_MANIFEST_MISMATCH', '构建清单与候选HTML不一致');
  }

  const release = {
    schemaVersion: 1,
    channel,
    candidateVersion: releaseAudit.candidate.currentCompatibleVersion,
    protocolCompatibilityVersion: releaseAudit.candidate.protocolCompatibilityVersion,
    title: releaseAudit.candidate.title,
    sourceCommit,
    sha256: digest(indexBytes),
    bytes: indexBytes.length,
    buildManifestSha256: digest(manifestBytes),
    generatedAt: manifest.generatedAt,
    productionWriteEnablementIncluded: false,
  };

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(dist, 'index.html'), path.join(target, 'index.html'));
  fs.copyFileSync(path.join(dist, 'build-manifest.json'), path.join(target, 'build-manifest.json'));
  fs.writeFileSync(path.join(target, 'pages-release.json'), `${JSON.stringify(release, null, 2)}\n`, 'utf8');

  const files = fs.readdirSync(target).sort();
  if (JSON.stringify(files) !== JSON.stringify([...PUBLIC_ARTIFACT_FILES].sort())) {
    fail('PAGES_ARTIFACT_SCOPE_INVALID', '公开产物文件范围无效', { files });
  }
  return Object.freeze({ outputDirectory: target, files: Object.freeze(files), release: Object.freeze(release) });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = preparePagesArtifact({
    root,
    outputDirectory: argumentValue('--output'),
    commitSha: argumentValue('--commit'),
    channel: argumentValue('--channel') || 'github-pages-backup',
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
