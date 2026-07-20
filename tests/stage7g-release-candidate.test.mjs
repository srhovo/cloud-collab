import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATE_PATH = path.join(ROOT, 'release', 'candidates', '码单器8.2.30_候选.html');
const RELEASE_MANIFEST_PATH = path.join(ROOT, 'release', 'final-release-manifest-v1.json');

test('阶段7G候选是单文件8.2.30且不包含旧候选版本号', () => {
  const candidate = fs.readFileSync(CANDIDATE_PATH);
  const html = candidate.toString('utf8');
  assert.equal(html.startsWith('<!DOCTYPE html>'), true);
  assert.equal(html.includes('<title>码单器8.2.30（公共协作完整候选版）</title>'), true);
  assert.equal(html.includes("const APP_VERSION = '8.2.30';"), true);
  assert.equal(html.includes('8.2.28'), false);
  assert.equal(html.includes('<script'), true);
  assert.equal(html.includes('<style'), true);
});

test('阶段7G最终发布清单与候选摘要一致且未晋升稳定版', () => {
  const candidate = fs.readFileSync(CANDIDATE_PATH);
  const releaseManifest = JSON.parse(fs.readFileSync(RELEASE_MANIFEST_PATH, 'utf8'));
  const sha256 = crypto.createHash('sha256').update(candidate).digest('hex');
  assert.equal(releaseManifest.releaseState, 'candidate_ready_not_promoted');
  assert.equal(releaseManifest.candidate.version, '8.2.30');
  assert.equal(releaseManifest.candidate.sha256, sha256);
  assert.equal(releaseManifest.candidate.bytes, candidate.length);
  assert.equal(releaseManifest.stable.version, '8.2.25');
  assert.equal(releaseManifest.stable.unchanged, true);
  assert.equal(releaseManifest.stable.promotionPerformed, false);
  assert.equal(releaseManifest.boundaries.stablePromotionAuthorized, false);
  assert.equal(releaseManifest.boundaries.stablePromotionPerformed, false);
  assert.equal(releaseManifest.boundaries.productionWriteEnablementIncluded, false);
});
