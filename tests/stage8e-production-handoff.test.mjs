import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('阶段8E生成零启用的生产交接报告', () => {
  const stdout = execFileSync(process.execPath, ['scripts/build-production-handoff-v1.mjs'], { cwd: root, encoding: 'utf8' }).trim();
  const report = JSON.parse(stdout);
  assert.equal(report.stage, '8E');
  assert.equal(report.status, 'handoff_ready_waiting_owner_domain');
  assert.equal(report.candidate.version, '8.2.31');
  assert.equal(report.stable.current, '8.2.25');
  assert.equal(report.stable.target, '8.3.0');
  assert.equal(report.stable.promotionAuthorized, false);
  assert.deepEqual(report.artifacts.public, ['index.html', 'build-manifest.json', 'pages-release.json']);
  assert.deepEqual(report.artifacts.administrator, ['index.html', 'production-console.css', 'production-console.js', 'admin-release.json']);
  assert.equal(report.artifacts.toolsDeployed, false);
  assert.equal(report.offlineGenerator.privateValueCount, 8);
  assert.equal(report.offlineGenerator.randomBytesPerValue, 48);
  assert.equal(report.manualActions.length, 6);
  assert.equal(report.boundaries.deploymentPerformed, false);
  assert.equal(report.boundaries.realBlobOperationsPerformed, 0);
  assert.equal(report.boundaries.productionActivationPerformed, false);
  assert.equal(report.boundaries.stablePromotionAuthorized, false);
});

test('离线工具强随机且没有网络、持久化、Cookie或剪贴板能力', () => {
  const html = read('tools/production-secret-generator.html');
  const js = read('tools/production-secret-generator.js');
  const combined = `${html}\n${js}\n${read('tools/production-secret-generator.css')}`;
  assert.match(html, /connect-src 'none'/u);
  assert.equal((html.match(/data-private-name=/gu) || []).length, 8);
  assert.match(js, /crypto\.getRandomValues/u);
  assert.match(js, /new Uint8Array\(48\)/u);
  assert.match(js, /pagehide/u);
  assert.doesNotMatch(combined, /\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon/u);
  assert.doesNotMatch(combined, /localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.clipboard/u);
});

test('三类产物互斥且交接输出不含启用声明', () => {
  const publicBuilder = read('scripts/prepare-public-candidate-v1.mjs');
  const adminBuilder = read('scripts/prepare-admin-console-v1.mjs');
  assert.doesNotMatch(publicBuilder, /production-secret-generator|production-console/u);
  assert.doesNotMatch(adminBuilder, /production-secret-generator/u);
  const files = [
    read('dist/production-handoff-v1.json'),
    read('dist/production-owner-actions-v1.md'),
    read('dist/production-edgeone-env-template-v1.txt'),
  ].join('\n');
  assert.doesNotMatch(files, /eo_token=/iu);
  assert.doesNotMatch(files, /CLOUD_PRODUCTION_ENABLED=1/u);
  assert.doesNotMatch(files, /"stablePromotionAuthorized"\s*:\s*true/u);
  assert.match(files, /getStore/u);
});
