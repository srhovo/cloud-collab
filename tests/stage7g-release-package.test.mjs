import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageReleaseCandidate } from '../scripts/package-release-candidate-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const VERSION = '8.2.31';
const FROZEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'release', `最终发布清单_${VERSION}.json`), 'utf8'));

test('阶段7J生成8.2.31候选单文件与最终发布清单', () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stage7j-package-'));
  try {
    const result = packageReleaseCandidate({ root: ROOT, outputDirectory });
    const candidatePath = path.join(outputDirectory, result.candidateFilename);
    const manifestPath = path.join(outputDirectory, result.manifestFilename);
    const auditPath = path.join(outputDirectory, result.auditFilename);

    assert.equal(result.candidateFilename, `码单器${VERSION}_候选.html`);
    assert.equal(result.manifestFilename, `最终发布清单_${VERSION}.json`);
    assert.equal(result.auditFilename, `发布审计_${VERSION}.json`);
    assert.equal(fs.existsSync(candidatePath), true);
    assert.equal(fs.existsSync(manifestPath), true);
    assert.equal(fs.existsSync(auditPath), true);

    const candidate = fs.readFileSync(candidatePath);
    const generatedManifestText = fs.readFileSync(manifestPath, 'utf8');
    const committedManifestText = fs.readFileSync(path.join(ROOT, 'release', `最终发布清单_${VERSION}.json`), 'utf8');
    const manifest = JSON.parse(generatedManifestText);
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));

    assert.equal(candidate.toString('utf8').includes(`const APP_VERSION = '${VERSION}';`), true);
    assert.equal(candidate.toString('utf8').includes(`<title>码单器${VERSION}（公共协作发布候选版）</title>`), true);
    assert.equal((candidate.toString('utf8').match(/<script\b/gi) || []).length, 1);
    assert.equal(manifest.releaseStatus, 'candidate_packaged_not_promoted');
    assert.equal(manifest.candidate.version, VERSION);
    assert.equal(manifest.candidate.sha256, digest(candidate));
    assert.equal(manifest.candidate.sha256, FROZEN.candidate.sha256);
    assert.equal(manifest.candidate.bytes, candidate.length);
    assert.equal(manifest.candidate.bytes, FROZEN.candidate.bytes);
    assert.equal(manifest.stable.version, '8.2.25');
    assert.equal(manifest.stable.unchanged, true);
    assert.equal(manifest.stable.promotionAuthorized, false);
    assert.equal(manifest.stable.promotionPerformed, false);
    assert.equal(manifest.decisions.cleanupExactEvidenceWaiverAcceptedByOwner, true);
    assert.equal(manifest.decisions.cleanupExactDeletionCountsRecorded, false);
    assert.equal(manifest.decisions.cleanupIndependentZeroCountEvidenceRecorded, false);
    assert.equal(manifest.decisions.productionWriteEnablementAuthorized, false);
    assert.equal(audit.status, 'promotion_authorization_required');
    assert.deepEqual(audit.blockers, []);
    assert.equal(generatedManifestText, committedManifestText);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('阶段7J最终发布清单对同一构建输入保持确定性', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'stage7j-package-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'stage7j-package-b-'));
  try {
    const resultA = packageReleaseCandidate({ root: ROOT, outputDirectory: first });
    const resultB = packageReleaseCandidate({ root: ROOT, outputDirectory: second });
    const manifestA = fs.readFileSync(path.join(first, resultA.manifestFilename), 'utf8');
    const manifestB = fs.readFileSync(path.join(second, resultB.manifestFilename), 'utf8');
    const candidateA = fs.readFileSync(path.join(first, resultA.candidateFilename));
    const candidateB = fs.readFileSync(path.join(second, resultB.candidateFilename));

    assert.equal(manifestA, manifestB);
    assert.equal(digest(candidateA), digest(candidateB));
    assert.equal(candidateA.equals(candidateB), true);
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});
