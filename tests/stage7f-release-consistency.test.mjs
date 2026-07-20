import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PagesArtifactError,
  preparePagesArtifact,
  PUBLIC_ARTIFACT_FILES,
} from '../scripts/prepare-pages-artifact.mjs';
import {
  PagesVerificationError,
  verifyPagesDeployment,
} from '../scripts/verify-pages-deployment.mjs';
import { auditStage7FRepository } from '../scripts/stage7f-repository-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = 'a'.repeat(40);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const FIXTURE_FILES = [
  'package.json',
  '.env.example',
  'scripts/build-stage6b-compatible.mjs',
  'dist/index.html',
  'dist/build-manifest.json',
  'release/release-closure-ledger-v1.json',
];

function fixture({ releaseReady = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage7f-pages-'));
  for (const relativePath of FIXTURE_FILES) {
    const source = path.join(ROOT, relativePath);
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  fs.writeFileSync(path.join(root, 'dist', 'admin-preview.html'), 'must not publish', 'utf8');
  if (releaseReady) {
    const ledgerPath = path.join(root, 'release', 'release-closure-ledger-v1.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    ledger.evidence.realDevice.finalCleanSnapshotAndTombstoneRerun = 'passed';
    ledger.evidence.cleanup.exactDeletionCountsRecorded = true;
    ledger.evidence.cleanup.independentZeroCountEvidenceRecorded = true;
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  }
  return root;
}

function onlineFixture({ sourceCommit = COMMIT, channel = 'github-pages-backup' } = {}) {
  const index = Buffer.from('<!doctype html><title>码单器8.2.30（公共协作完整候选版）</title>', 'utf8');
  const manifest = {
    version: '8.2.30',
    protocolCompatibilityVersion: '8.2.28',
    sha256: digest(index),
    bytes: index.length,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const release = {
    schemaVersion: 1,
    channel,
    candidateVersion: '8.2.30',
    protocolCompatibilityVersion: '8.2.28',
    title: '码单器8.2.30（公共协作完整候选版）',
    sourceCommit,
    sha256: digest(index),
    bytes: index.length,
    buildManifestSha256: digest(manifestBytes),
    productionWriteEnablementIncluded: false,
  };
  const assets = new Map([
    ['/cloud-collab/index.html', index],
    ['/cloud-collab/build-manifest.json', manifestBytes],
    ['/cloud-collab/pages-release.json', Buffer.from(`${JSON.stringify(release)}\n`, 'utf8')],
  ]);
  const fetchImpl = async value => {
    const url = new URL(value);
    const body = assets.get(url.pathname);
    return body ? new Response(body, { status: 200 }) : new Response('missing', { status: 404 });
  };
  return { fetchImpl };
}

test('阶段7F仓库审计确认手动发布、最小产物和剩余证据阻断', () => {
  const report = auditStage7FRepository({ root: ROOT });
  assert.equal(report.status, 'passed_with_release_blockers');
  assert.equal(report.candidate.currentCompatibleVersion, '8.2.30');
  assert.equal(report.candidate.protocolCompatibilityVersion, '8.2.28');
  assert.deepEqual(report.checks.pagesMinimalArtifactAllowlist, PUBLIC_ARTIFACT_FILES);
  assert.deepEqual(report.checks.edgeOneMinimalArtifactAllowlist, PUBLIC_ARTIFACT_FILES);
  assert.equal(report.inventory.excludedPreviewPages.length, 8);
  assert.deepEqual(report.inventory.externalRuntimeDependencies, [
    'https://cdn.jsdelivr.net/gh/srhovo/tutorialvideo@main/video.mp4',
  ]);
  assert.deepEqual(report.remainingReleaseBlockers, [
    'real_device_final_rerun_exception_acceptance',
    'cleanup_exact_evidence_missing',
  ]);
});

test('发布证据未闭环时拒绝生成GitHub Pages公开产物', () => {
  const root = fixture();
  try {
    assert.throws(
      () => preparePagesArtifact({ root, commitSha: COMMIT }),
      error => error instanceof PagesArtifactError
        && error.code === 'PAGES_RELEASE_NOT_READY'
        && error.details.blockers.length === 2,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('公开产物生成器拒绝仓库根目录或任意目录作为清理目标', () => {
  const root = fixture({ releaseReady: true });
  try {
    for (const outputDirectory of [root, path.join(root, 'dist')]) {
      assert.throws(
        () => preparePagesArtifact({ root, outputDirectory, commitSha: COMMIT }),
        error => error instanceof PagesArtifactError && error.code === 'PAGES_OUTPUT_UNSAFE',
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('证据闭环后只生成三个白名单文件并排除管理员预览页', () => {
  const root = fixture({ releaseReady: true });
  try {
    const result = preparePagesArtifact({ root, commitSha: COMMIT });
    assert.deepEqual(result.files, [...PUBLIC_ARTIFACT_FILES].sort());
    assert.equal(result.release.candidateVersion, '8.2.30');
    assert.equal(result.release.protocolCompatibilityVersion, '8.2.28');
    assert.equal(result.release.sourceCommit, COMMIT);
    assert.equal(fs.existsSync(path.join(result.outputDirectory, 'admin-preview.html')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EdgeOne主入口使用同一三文件白名单和独立通道标识', () => {
  const root = fixture({ releaseReady: true });
  try {
    const outputDirectory = path.join(root, '.edgeone-artifact');
    const result = preparePagesArtifact({
      root,
      outputDirectory,
      commitSha: COMMIT,
      channel: 'edgeone-primary',
    });
    assert.deepEqual(result.files, [...PUBLIC_ARTIFACT_FILES].sort());
    assert.equal(result.release.channel, 'edgeone-primary');
    assert.equal(fs.existsSync(path.join(outputDirectory, 'admin-preview.html')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('部署后验证提交、标题、HTML摘要和构建清单', async () => {
  const result = await verifyPagesDeployment({
    url: 'https://pages.test/cloud-collab/',
    expectedCommitSha: COMMIT,
    fetchImpl: onlineFixture().fetchImpl,
    attempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.sourceCommit, COMMIT);
  assert.equal(result.candidateVersion, '8.2.30');
});

test('线上提交不是预期提交时验证失败关闭', async () => {
  await assert.rejects(
    verifyPagesDeployment({
      url: 'https://pages.test/cloud-collab/',
      expectedCommitSha: COMMIT,
      fetchImpl: onlineFixture({ sourceCommit: 'b'.repeat(40) }).fetchImpl,
      attempts: 1,
      retryDelayMs: 0,
    }),
    error => error instanceof PagesVerificationError
      && error.code === 'PAGES_VERIFY_FAILED'
      && error.details.causeCode === 'PAGES_RELEASE_IDENTITY_MISMATCH',
  );
});

test('EdgeOne线上通道可使用相同摘要验证器', async () => {
  const result = await verifyPagesDeployment({
    url: 'https://edgeone.test/cloud-collab/',
    expectedCommitSha: COMMIT,
    expectedChannel: 'edgeone-primary',
    fetchImpl: onlineFixture({ channel: 'edgeone-primary' }).fetchImpl,
    attempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(result.status, 'verified');
});
