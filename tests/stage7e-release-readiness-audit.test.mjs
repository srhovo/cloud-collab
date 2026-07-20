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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage7e-release-'));
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

test('阶段7F审计记录已接受豁免并准确列出剩余发布决策项', () => {
  const report = auditReleaseRepository({ root: ROOT });
  assert.equal(report.status, 'decision_required');
  assert.equal(report.stable.version, '8.2.25');
  assert.equal(report.stable.source, 'external_frozen_baseline');
  assert.equal(report.stable.filename, '码单器8.2.25_现.html');
  assert.equal(report.stable.sha256, 'd34a436d5910ab027ad466309c44c6607fc8b60d2b21cf4b1cc4bf5a188bd6d3');
  assert.equal(report.stable.bytes, 908220);
  assert.equal(report.stable.repositoryCopyExpected, false);
  assert.equal(report.candidate.currentCompatibleVersion, '8.2.28');
  assert.equal(report.candidate.recommendedVersionFromPlan, '8.2.30');
  assert.equal(report.candidate.ownerDecision, null);
  assert.equal(report.environment.allEnabledGatesDefaultOff, true);
  assert.equal(report.environment.examplePrivateValuesEmpty, true);
  assert.equal(report.evidence.automated.stage7eWorkflowRunNumber, 1173);
  assert.equal(report.evidence.automated.stage7eWorkflowConclusion, 'success');
  assert.equal(report.evidence.automated.stage7eNodeTestCount, 282);
  assert.equal(report.evidence.automated.stage7eNodeTestFailures, 0);
  assert.equal(report.evidence.realDevice.finalCleanSnapshotAndTombstoneRerun, 'waived_due_to_manual_cost');
  assert.equal(report.evidence.realDevice.finalCleanSnapshotAndTombstoneRerunExceptionAcceptedByOwner, true);
  assert.equal(report.evidence.temporaryResources.status, 'verified_destroyed');
  assert.equal(report.evidence.temporaryResources.evidenceSource, 'user_report');
  assert.deepEqual(report.blockers, [
    'candidate_version_owner_decision',
    'cleanup_exact_evidence_missing',
  ]);
  assert.deepEqual(report.boundaries, {
    filesModifiedByAudit: 0,
    deploymentsPerformed: 0,
    blobMutationsPerformed: 0,
    productionWriteEnablementIncluded: false,
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

test('阶段7E自动化证据无效时失败关闭', () => {
  const root = copyFixture();
  try {
    mutateJson(root, 'release/release-closure-ledger-v1.json', ledger => {
      ledger.evidence.automated.stage7eNodeTestFailures = 1;
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

test('剩余证据补齐后仍只进入独立晋升授权状态', () => {
  const root = copyFixture();
  try {
    mutateJson(root, 'release/release-closure-ledger-v1.json', ledger => {
      ledger.candidateVersionDecision = '8.2.30';
      ledger.evidence.cleanup.exactDeletionCountsRecorded = true;
      ledger.evidence.cleanup.independentZeroCountEvidenceRecorded = true;
      ledger.evidence.temporaryResources.status = 'verified_destroyed';
    });
    const report = auditReleaseRepository({ root });
    assert.equal(report.status, 'promotion_authorization_required');
    assert.deepEqual(report.blockers, []);
    assert.equal(report.boundaries.promotionPerformed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
