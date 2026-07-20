import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { preparePublicCandidate, PUBLIC_CANDIDATE_FILES, PublicCandidateArtifactError } from '../scripts/prepare-public-candidate-v1.mjs';
import { verifyPublicDeployment, PublicDeploymentVerificationError } from '../scripts/verify-public-deployment-v1.mjs';
import { auditStage7HRepository } from '../scripts/stage7h-release-rehearsal-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = 'a'.repeat(40);
const VERSION = '8.2.31';
const FROZEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'release', '最终发布清单_8.2.31.json'), 'utf8'));
const FIXTURE_FILES = [
  'package.json', '.env.example', 'scripts/build-stage6b-compatible.mjs',
  'dist/index.html', 'dist/build-manifest.json', 'release/release-closure-ledger-v1.json',
  'release/最终发布清单_8.2.31.json',
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage7j-publication-'));
  for (const relativePath of FIXTURE_FILES) {
    const source = path.join(ROOT, relativePath);
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return root;
}
function artifactFixture(channel = 'edgeone-primary') {
  const root = fixture();
  const outputDirectory = path.join(root, channel === 'edgeone-primary' ? '.edgeone-artifact' : '.pages-artifact');
  const result = preparePublicCandidate({ root, outputDirectory, commitSha: COMMIT, channel });
  const assets = new Map();
  for (const filename of result.files) assets.set(`/candidate/${filename}`, fs.readFileSync(path.join(outputDirectory, filename)));
  return { root, result, assets };
}
function responseHeaders(filename, { edgeHeaders = true, omit = null, jsonCharset = true } = {}) {
  const headers = new Headers();
  headers.set('Content-Type', filename.endsWith('.html') ? 'text/html; charset=utf-8' : jsonCharset ? 'application/json; charset=utf-8' : 'application/json');
  if (edgeHeaders) {
    const values = new Map([
      ['Cache-Control', 'no-cache, max-age=0, must-revalidate'],
      ['X-Content-Type-Options', 'nosn'], ['X-Frame-Options', 'DENY'], ['Referrer-Policy', 'no-referrer'],
    ]);
    for (const [key, value] of values) if (key.toLowerCase() !== String(omit || '').toLowerCase()) headers.set(key, value);
  }
  return headers;
}
function fetchFixture(assets, options = {}) {
  return async value => {
    const url = new URL(value);
    if (url.pathname.endsWith('/admin-sensitive-reviews-preview.html')) {
      return options.exposeAdmin
        ? new Response('<title>admin</title>', { status: 200, headers: responseHeaders('admin.html', options) })
        : new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    const body = assets.get(url.pathname);
    if (!body) return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    const filename = path.posix.basename(url.pathname);
    return new Response(body, { status: 200, headers: responseHeaders(filename, options) });
  };
}

test('阶段7J仓库审计确认8.2.31双入口预演已准备且未部署', () => {
  const report = auditStage7HRepository({ root: ROOT });
  assert.equal(report.status, 'rehearsal_ready_not_deployed');
  assert.equal(report.candidate.version, VERSION);
  assert.equal(report.candidate.sha256, FROZEN.candidate.sha256);
  assert.equal(report.candidate.bytes, FROZEN.candidate.bytes);
  assert.deepEqual(report.publicArtifactAllowlist, PUBLIC_CANDIDATE_FILES);
  assert.equal(report.checks.pagesManualDispatchOnly, true);
  assert.equal(report.checks.rehearsalWorkflowDoesNotDeploy, true);
  assert.equal(report.checks.publicJsonUtf8CharsetConfigured, true);
  assert.equal(report.boundaries.deploymentPerformed, false);
  assert.equal(report.boundaries.stablePromotionPerformed, false);
});

test('公开候选生成器只输出三个文件并绑定阶段7J冻结摘要', () => {
  const root = fixture();
  try {
    const result = preparePublicCandidate({ root, outputDirectory: path.join(root, '.pages-artifact'), commitSha: COMMIT, channel: 'github-pages-backup' });
    assert.deepEqual(result.files, [...PUBLIC_CANDIDATE_FILES].sort());
    assert.equal(result.release.candidate.version, VERSION);
    assert.equal(result.release.candidate.sha256, FROZEN.candidate.sha256);
    assert.equal(result.release.candidate.bytes, FROZEN.candidate.bytes);
    assert.equal(result.release.stable.promotionAuthorized, false);
    assert.equal(result.release.stable.promotionPerformed, false);
    assert.equal(result.release.productionWriteEnablementIncluded, false);
    assert.equal(fs.existsSync(path.join(result.outputDirectory, 'admin-sensitive-reviews-preview.html')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('冻结候选摘要被修改时公开产物失败关闭', () => {
  const root = fixture();
  try {
    const manifestPath = path.join(root, 'release', '最终发布清单_8.2.31.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.candidate.sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    assert.throws(
      () => preparePublicCandidate({ root, outputDirectory: path.join(root, '.edgeone-artifact'), commitSha: COMMIT, channel: 'edgeone-primary' }),
      error => error instanceof PublicCandidateArtifactError && error.code === 'PUBLIC_CANDIDATE_FROZEN_HASH_MISMATCH',
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('公开产物生成器拒绝仓库根目录作为清理目标', () => {
  const root = fixture();
  try {
    assert.throws(
      () => preparePublicCandidate({ root, outputDirectory: root, commitSha: COMMIT }),
      error => error instanceof PublicCandidateArtifactError && error.code === 'PUBLIC_CANDIDATE_OUTPUT_UNSAFE',
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('EdgeOne候选入口验证提交、摘要、响应头和公开范围', async () => {
  const data = artifactFixture('edgeone-primary');
  try {
    const result = await verifyPublicDeployment({
      url: 'https://edgeone.test/candidate/', expectedCommitSha: COMMIT, expectedChannel: 'edgeone-primary',
      fetchImpl: fetchFixture(data.assets), attempts: 1, retryDelayMs: 0,
    });
    assert.equal(result.status, 'verified_candidate_preview_not_stable');
    assert.equal(result.candidateVersion, VERSION);
    assert.equal(result.publicJsonUtf8Verified, true);
    assert.equal(result.stablePromotionPerformed, false);
  } finally { fs.rmSync(data.root, { recursive: true, force: true }); }
});

test('GitHub Pages备用入口不依赖EdgeOne专属安全头', async () => {
  const data = artifactFixture('github-pages-backup');
  try {
    const result = await verifyPublicDeployment({
      url: 'https://pages.test/candidate/', expectedCommitSha: COMMIT, expectedChannel: 'github-pages-backup',
      fetchImpl: fetchFixture(data.assets, { edgeHeaders: false }), attempts: 1, retryDelayMs: 0,
    });
    assert.equal(result.channel, 'github-pages-backup');
  } finally { fs.rmSync(data.root, { recursive: true, force: true }); }
});

test('EdgeOne缺少安全响应头时线上验证失败关闭', async () => {
  const data = artifactFixture('edgeone-primary');
  try {
    await assert.rejects(
      verifyPublicDeployment({
        url: 'https://edgeone.test/candidate/', expectedCommitSha: COMMIT, expectedChannel: 'edgeone-primary',
        fetchImpl: fetchFixture(data.assets, { omit: 'X-Frame-Options' }), attempts: 1, retryDelayMs: 0,
      }),
      error => error instanceof PublicDeploymentVerificationError && error.code === 'PUBLIC_DEPLOYMENT_VERIFY_FAILED' && error.details.causeCode === 'PUBLIC_DEPLOYMENT_SECURITY_HEADER_INVALID',
    );
  } finally { fs.rmSync(data.root, { recursive: true, force: true }); }
});

test('EdgeOne公开JSON缺少UTF-8字符集时线上验证失败关闭', async () => {
  const data = artifactFixture('edgeone-primary');
  try {
    await assert.rejects(
      verifyPublicDeployment({
        url: 'https://edgeone.test/candidate/', expectedCommitSha: COMMIT, expectedChannel: 'edgeone-primary',
        fetchImpl: fetchFixture(data.assets, { jsonCharset: false }), attempts: 1, retryDelayMs: 0,
      }),
      error => error instanceof PublicDeploymentVerificationError && error.code === 'PUBLIC_DEPLOYMENT_VERIFY_FAILED' && error.details.causeCode === 'PUBLIC_DEPLOYMENT_CONTENT_TYPE_INVALID',
    );
  } finally { fs.rmSync(data.root, { recursive: true, force: true }); }
});

test('管理员预览页被公开时线上验证失败关闭', async () => {
  const data = artifactFixture('edgeone-primary');
  try {
    await assert.rejects(
      verifyPublicDeployment({
        url: 'https://edgeone.test/candidate/', expectedCommitSha: COMMIT, expectedChannel: 'edgeone-primary',
        fetchImpl: fetchFixture(data.assets, { exposeAdmin: true }), attempts: 1, retryDelayMs: 0,
      }),
      error => error instanceof PublicDeploymentVerificationError && error.code === 'PUBLIC_DEPLOYMENT_VERIFY_FAILED' && error.details.causeCode === 'PUBLIC_DEPLOYMENT_PREVIEW_PAGE_EXPOSED',
    );
  } finally { fs.rmSync(data.root, { recursive: true, force: true }); }
});
