import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditReleaseRepository } from './release-readiness-audit-v1.mjs';
import {
  preparePublicCandidate,
  PUBLIC_CANDIDATE_FILES,
} from './prepare-public-candidate-v1.mjs';

const CANDIDATE_VERSION = '8.2.31';
const CANDIDATE_SHA256 = '79c443e16d2560c43921dad51bfdc0152c440254d450f57b96326fdd27b2ccea';
const CANDIDATE_BYTES = 1155499;
const FINAL_RELEASE_MANIFEST = 'release/最终发布清单_8.2.31.json';

export class Stage7HRehearsalError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'Stage7HRehearsalError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new Stage7HRehearsalError(code, message, details);
};
const read = (root, relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function repositoryCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function includesAll(text, values, code, label) {
  const missing = values.filter(value => !text.includes(value));
  if (missing.length) fail(code, `${label}缺少候选发布门禁`, { missing });
}

function edgeOneHeaderMap(config, source) {
  const rule = Array.isArray(config.headers)
    ? config.headers.find(item => item?.source === source)
    : null;
  return new Map((rule?.headers || []).map(item => [String(item.key || '').toLowerCase(), String(item.value || '')]));
}

function assertJsonUtf8Header(config, source) {
  const headers = edgeOneHeaderMap(config, source);
  if (String(headers.get('content-type') || '').toLowerCase() !== 'application/json; charset=utf-8') {
    fail('STAGE7J_EDGEONE_JSON_CHARSET_INVALID', `${source}必须显式使用UTF-8 JSON响应头`);
  }
}

export function auditStage7HRepository({ root } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const releaseAudit = auditReleaseRepository({ root: repositoryRoot });
  if (releaseAudit.status !== 'promotion_authorization_required' || releaseAudit.blockers.length !== 0) {
    fail('STAGE7H_RELEASE_NOT_READY', '候选发布证据未闭环', {
      status: releaseAudit.status,
      blockers: releaseAudit.blockers,
    });
  }

  const packageJson = JSON.parse(read(repositoryRoot, 'package.json'));
  const edgeOneConfig = JSON.parse(read(repositoryRoot, 'edgeone.json'));
  const pagesWorkflow = read(repositoryRoot, '.github/workflows/pages.yml');
  const rehearsalWorkflow = read(repositoryRoot, '.github/workflows/stage7h-release-rehearsal.yml');
  const readme = read(repositoryRoot, 'README.md');
  const guide = read(repositoryRoot, 'docs/阶段7H_候选发布预演与大陆访问入口.md');
  const finalManifest = JSON.parse(read(repositoryRoot, FINAL_RELEASE_MANIFEST));

  if (/^\s+push\s*:/m.test(pagesWorkflow) || /^\s+pull_request\s*:/m.test(pagesWorkflow)) {
    fail('STAGE7H_PAGES_NOT_MANUAL_ONLY', 'GitHub Pages候选备用入口必须只允许手动触发');
  }
  includesAll(pagesWorkflow, [
    'workflow_dispatch:',
    'candidate_version:',
    'DEPLOY-CANDIDATE-8.2.31',
    'npm ci --ignore-scripts',
    'npm run ci',
    'npm run public:prepare',
    'path: ./.pages-artifact',
    'actions/deploy-pages@v4',
    'npm run public:verify',
  ], 'STAGE7H_PAGES_GATE_INCOMPLETE', 'GitHub Pages工作流');

  includesAll(rehearsalWorkflow, [
    'pull_request:',
    'npm ci --ignore-scripts',
    'npm run release:rehearse',
    '.pages-artifact',
    '.edgeone-artifact',
    'dist/stage7h-release-rehearsal.json',
    'release/最终发布清单_8.2.31.json',
  ], 'STAGE7H_REHEARSAL_WORKFLOW_INCOMPLETE', '候选发布预演工作流');
  if (rehearsalWorkflow.includes('actions/deploy-pages')) {
    fail('STAGE7H_REHEARSAL_DEPLOYMENT_PRESENT', '候选发布预演工作流不得执行真实部署');
  }

  if (edgeOneConfig.installCommand !== 'npm ci --ignore-scripts'
      || edgeOneConfig.buildCommand !== 'npm run edgeone:build'
      || edgeOneConfig.outputDirectory !== './.edgeone-artifact'
      || edgeOneConfig.nodeVersion !== '22.11.0') {
    fail('STAGE7H_EDGEONE_BUILD_SCOPE_INVALID', 'EdgeOne构建未固定为锁定安装和最小公开产物');
  }
  const headers = edgeOneHeaderMap(edgeOneConfig, '/*');
  const cacheControl = String(headers.get('cache-control') || '').toLowerCase();
  if (!cacheControl.includes('max-age=0')
      || !cacheControl.includes('must-revalidate')
      || String(headers.get('x-content-type-options') || '').toLowerCase() !== 'nosniff'
      || String(headers.get('x-frame-options') || '').toLowerCase() !== 'deny'
      || String(headers.get('referrer-policy') || '').toLowerCase() !== 'no-referrer') {
    fail('STAGE7H_EDGEONE_HEADERS_INVALID', 'EdgeOne候选入口缓存或安全响应头无效');
  }
  assertJsonUtf8Header(edgeOneConfig, '/build-manifest.json');
  assertJsonUtf8Header(edgeOneConfig, '/pages-release.json');

  const scripts = packageJson.scripts || {};
  if (scripts['public:prepare'] !== 'node scripts/prepare-public-candidate-v1.mjs'
      || scripts['public:verify'] !== 'node scripts/verify-public-deployment-v1.mjs'
      || scripts['stage7h:audit'] !== 'node scripts/stage7h-release-rehearsal-v1.mjs --audit-only'
      || scripts['release:rehearse'] !== 'npm run ci && node scripts/stage7h-release-rehearsal-v1.mjs'
      || scripts['edgeone:build'] !== 'npm run ci && npm run public:prepare -- --channel edgeone-primary --output .edgeone-artifact'
      || !String(scripts.validate || '').includes('npm run stage7h:audit')) {
    fail('STAGE7H_PACKAGE_SCRIPTS_INVALID', 'package.json候选发布命令契约无效');
  }

  if (finalManifest.candidate?.version !== CANDIDATE_VERSION
      || finalManifest.candidate?.sha256 !== CANDIDATE_SHA256
      || finalManifest.candidate?.bytes !== CANDIDATE_BYTES
      || finalManifest.stable?.promotionAuthorized !== false
      || finalManifest.stable?.promotionPerformed !== false) {
    fail('STAGE7H_FROZEN_CANDIDATE_INVALID', '阶段7J冻结候选身份无效');
  }

  includesAll(readme, [
    '阶段7J',
    CANDIDATE_VERSION,
    '稳定版8.2.25未晋升',
    '正式公共写入保持关闭',
  ], 'STAGE7H_README_STALE', 'README');
  includesAll(guide, [
    'EdgeOne Pages',
    'GitHub Pages',
    'ICP备案',
    'Wi-Fi',
    '移动数据',
    '不晋升稳定版',
  ], 'STAGE7H_GUIDE_INCOMPLETE', '大陆访问入口方案');

  return Object.freeze({
    schemaVersion: 1,
    stage: '7J-candidate-release-rehearsal',
    status: 'rehearsal_ready_not_deployed',
    candidate: Object.freeze({
      version: finalManifest.candidate.version,
      sha256: finalManifest.candidate.sha256,
      bytes: finalManifest.candidate.bytes,
    }),
    publicArtifactAllowlist: PUBLIC_CANDIDATE_FILES,
    entryStrategy: Object.freeze({
      primary: 'edgeone-pages-candidate-preview',
      backup: 'github-pages-manual-candidate',
      offline: 'verified-single-html',
    }),
    checks: Object.freeze({
      pagesManualDispatchOnly: true,
      rehearsalWorkflowDoesNotDeploy: true,
      edgeOneMinimalArtifactOnly: true,
      edgeOneSecurityHeadersConfigured: true,
      publicJsonUtf8CharsetConfigured: true,
      postDeploymentHashVerificationRequired: true,
      adminPreviewPagesExcluded: true,
    }),
    boundaries: Object.freeze({
      deploymentPerformed: false,
      stablePromotionAuthorized: false,
      stablePromotionPerformed: false,
      productionWriteEnablementIncluded: false,
      blobMutationsPerformed: 0,
    }),
  });
}

export function rehearseStage7H({ root, commitSha } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const audit = auditStage7HRepository({ root: repositoryRoot });
  const commit = String(commitSha || process.env.GITHUB_SHA || repositoryCommit(repositoryRoot)).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('STAGE7H_COMMIT_INVALID', '候选发布预演需要40位Git提交SHA');

  const pages = preparePublicCandidate({
    root: repositoryRoot,
    outputDirectory: path.join(repositoryRoot, '.pages-artifact'),
    commitSha: commit,
    channel: 'github-pages-backup',
  });
  const edgeOne = preparePublicCandidate({
    root: repositoryRoot,
    outputDirectory: path.join(repositoryRoot, '.edgeone-artifact'),
    commitSha: commit,
    channel: 'edgeone-primary',
  });

  for (const filename of ['index.html', 'build-manifest.json']) {
    const pagesBytes = fs.readFileSync(path.join(pages.outputDirectory, filename));
    const edgeOneBytes = fs.readFileSync(path.join(edgeOne.outputDirectory, filename));
    if (!pagesBytes.equals(edgeOneBytes)) {
      fail('STAGE7H_CHANNEL_ARTIFACT_MISMATCH', '主备入口候选内容不一致', { filename });
    }
  }
  if (pages.release.candidate.sha256 !== edgeOne.release.candidate.sha256
      || pages.release.sourceCommit !== edgeOne.release.sourceCommit
      || pages.release.channel === edgeOne.release.channel) {
    fail('STAGE7H_CHANNEL_IDENTITY_INVALID', '主备入口发布身份无效');
  }

  const report = {
    ...audit,
    status: 'rehearsal_passed_not_deployed',
    sourceCommit: commit,
    artifacts: {
      githubPagesBackup: {
        directory: '.pages-artifact',
        files: pages.files,
        channel: pages.release.channel,
      },
      edgeOnePrimary: {
        directory: '.edgeone-artifact',
        files: edgeOne.files,
        channel: edgeOne.release.channel,
      },
      candidateSha256: pages.release.candidate.sha256,
      candidateBytes: pages.release.candidate.bytes,
      byteIdenticalAcrossChannels: true,
    },
  };
  fs.writeFileSync(
    path.join(repositoryRoot, 'dist', 'stage7h-release-rehearsal.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  return Object.freeze(report);
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const auditOnly = process.argv.includes('--audit-only');
  const report = auditOnly
    ? auditStage7HRepository({ root })
    : rehearseStage7H({ root });
  if (auditOnly) {
    fs.writeFileSync(
      path.join(root, 'dist', 'stage7h-release-rehearsal.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
