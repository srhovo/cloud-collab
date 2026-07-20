import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditReleaseRepository,
  ReleaseReadinessAuditError,
} from '../scripts/release-readiness-audit-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_FILES = [
  'package.json',
  '.env.example',
  'scripts/build-stage6b-compatible.mjs',
  'dist/index.html',
  'dist/build-manifest.json',
  'release/release-closure-ledger-v1.json',
];

function copyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage7j-release-'));
  for (const relativePath of REQUIRED_FILES) {
    const source = path.join(ROOT, relativePath);
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return root;
}

function mutateJson(root, relativePath, mutate) {
  const absolutePath = path.join(root, relativePath);
  const value = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  mutate(value);
  fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('阶段7J审计确认8.2.31候选可打包但不得自动晋升', () => {
  const report = auditReleaseRepository({ root: ROOT });
  assert.equal(report.status, 'promotion_authorization_required');
  assert.equal(report.stable.version, '8.2.25');
  assert.equal(report.stable.source, 'external_frozen_baseline');
  assert.equal(report.stable.filename, '码单器8.2.25_现.html');
  assert.equal(report.stable.sha256, 'd34a436d5910ab027ad466309c44c6607fc8b60d2b21cf4b1cc4bf5a188bd6d3');
  assert.equal(report.stable.bytes, 908220);
  assert.equal(report.stable.repositoryCopyExpected, false);
  assert.equal(report.stable.promotionAuthorized, false);
  assert.equal(report.stable.promotionPerformed, false);
  assert.equal(report.candidate.currentCompatibleVersion, '8.2.31');
  assert.equal(report.candidate.recommendedVersionFromPlan, '8.2.30');
  assert.equal(report.candidate.ownerDecision, '8.2.31');
  assert.equal(report.candidate.sha256, '79c443e16d2560c43921dad51bfdc0152c440254d450f57b96326fdd27b2ccea');
  assert.equal(report.candidate.bytes, 1155499);
  assert.equal(report.candidate.packagingAuthorized, true);
  assert.equal(report.environment.allEnabledGatesDefaultOff, true);
  assert.equal(report.environment.examplePrivateValuesEmpty, true);
  assert.equal(report.evidence.automated.stage7iMainCommit, '06d49b649f2d74ae6220da58658ed7bc427fb702');
  assert.equal(report.evidence.automated.stage7iNodeTestCount, 297);
  assert.equal(report.evidence.automated.stage7iNodeTestFailures, 0);
  assert.equal(report.evidence.automated.stage7iEdgeOneCandidateDeployment, 'passed');
  assert.equal(report.evidence.realDevice.finalCleanSnapshotAndTombstoneRerun, 'waived_due_to_manual_cost');
  assert.equal(report.evidence.realDevice.finalCleanSnapshotAndTombstoneRerunExceptionAcceptedByOwner, true);
  assert.equal(report.evidence.cleanup.exactDeletionCountsRecorded, false);
  assert.equal(report.evidence.cleanup.independentZeroCountEvidenceRecorded, false);
  assert.equal(report.evidence.cleanup.exactEvidenceWaiverAcceptedByOwner, true);
  assert.equal(report.evidence.temporaryResources.status, 'verified_destroyed');
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.boundaries, {
    filesModifiedByAudit: 0,
    deploymentsPerformed: 0,
    blobMutationsPerformed: 0,
    productionWriteEnablementIncluded: false,
    stablePromotionAuthorized: false,
    stablePromotionPerformed: false,
    promotionPerformed: false,
  });
});

test('人工重跑豁免未获项目负责人接受时继续阻断', () => {
  const root = copyFixture();
  try {
    mutateJson(root, 'release/release-closure-ledger-v1.json', ledger => {
      ledger.evidence.realDevice.finalCleanSnapshotAndTombstoneRerunExceptionAcceptedByOwner = false;
    });
    const report = auditReleaseRepository({ root });
    assert.equal(report.status, 'decision_required');
    assert.equal(report.blockers.includes('real_device_final_rerun_exception_acceptance'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('清理精确数字缺失且未接受豁免时继续阻断', () => {
  const root = copyFixture();
  try {
    mutateJson(root, 'release/release-closure-ledger-v1.json', ledger => {
      ledger.evidence.cleanup.exactEvidenceWaiverAcceptedByOwner = false;
    });
    const report = auditReleaseRepository({ root });
    assert.equal(report.status, 'decision_required');
    assert.equal(report.blockers.includes('cleanup_exact_evidence_missing'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('候选构建版本与项目负责人决策不一致时失败关闭', () => {
  const root = copyFixture();
  try {
    mutateJson(root, 'release/release-closure-ledger-v1.json', ledger => {
      ledger.candidateVersionDecision = '8.2.29';
    });
    assert.throws(
      () => auditReleaseRepository({ root }),
      error => error instanceof ReleaseReadinessAuditError
        && error.code === 'RELEASE_CANDIDATE_DECISION_MISMATCH',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('任一预览能力默认开启时失败关闭', () => {
  const root = copyFixture();
  try {
    const envPath = path.join(root, '.env.example');
    const env = fs.readFileSync(envPath, 'utf8')
      .replace('CLOUD_WRITE_PREVIEW_ENABLED=0', 'CLOUD_WRITE_PREVIEW_ENABLED=1');
    fs.writeFileSync(envPath, env, 'utf8');
    assert.throws(
      () => auditReleaseRepository({ root }),
      error => error instanceof ReleaseReadinessAuditError
        && error.code === 'RELEASE_ENV_GATE_OPEN',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('构建清单与候选摘要不一致时失败关闭', () => {
  const root = copyFixture();
  try {
    mutateJson(root, 'dist/build-manifest.json', manifest => {
      manifest.sha256 = '0'.repeat(64);
    });
    assert.throws(
      () => auditReleaseRepository({ root }),
      error => error instanceof ReleaseReadinessAuditError
        && error.code === 'RELEASE_MANIFEST_HASH_MISMATCH',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('稳定基线元数据无效时失败关闭', () => {
  const root = copyFixture();
  try {
    mutateJson(root, 'release/release-closure-ledger-v1.json', ledger => {
      ledger.stableArtifact.sha256 = 'bad';
    });
    assert.throws(
      () => auditReleaseRepository({ root }),
      error => error instanceof ReleaseReadinessAuditError
        && error.code === 'RELEASE_STABLE_METADATA_INVALID',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('阶段7F自动化证据无效时失败关闭', () => {
  const root = copyFixture();
  try {
    mutateJson(root, 'release/release-closure-ledger-v1.json', ledger => {
      ledger.evidence.automated.stage7fNodeTestFailures = 1;
    });
    assert.throws(
      () => auditReleaseRepository({ root }),
      error => error instanceof ReleaseReadinessAuditError
        && error.code === 'RELEASE_AUTOMATED_EVIDENCE_FAILED',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('稳定晋升授权被意外开启时失败关闭', () => {
  const root = copyFixture();
  try {
    mutateJson(root, 'release/release-closure-ledger-v1.json', ledger => {
      ledger.releasePolicy.stablePromotionAuthorized = true;
    });
    assert.throws(
      () => auditReleaseRepository({ root }),
      error => error instanceof ReleaseReadinessAuditError
        && error.code === 'RELEASE_POLICY_INVALID',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
