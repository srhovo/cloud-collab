import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function parseEnv(text) {
  return new Map(text.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
}

test('生产交接构建器生成零启用、零真实资源的机器报告', () => {
  const stdout = execFileSync(process.execPath, ['scripts/build-production-handoff-v1.mjs'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const report = JSON.parse(stdout);
  assert.equal(report.stage, '8D');
  assert.equal(report.status, 'handoff_ready_waiting_owner_domain');
  assert.equal(report.candidate.version, '8.2.31');
  assert.equal(report.stable.current, '8.2.25');
  assert.equal(report.stable.target, '8.3.0');
  assert.equal(report.stable.promotionAuthorized, false);
  assert.deepEqual(report.publicArtifactAllowlist, ['index.html', 'build-manifest.json', 'pages-release.json']);
  assert.equal(report.offlineGenerator.networkAccess, false);
  assert.equal(report.offlineGenerator.persistentBrowserStorage, false);
  assert.equal(report.offlineGenerator.clipboardApiAccess, false);
  assert.equal(report.offlineGenerator.privateValueCount, 8);
  assert.equal(report.edgeOne.blobNamespaceManualCreationRequired, false);
  assert.equal(report.edgeOne.blobNamespaceCreation, 'first_sdk_getStore_call');
  assert.equal(report.manualActions.length, 6);
  assert.equal(report.boundaries.deploymentPerformed, false);
  assert.equal(report.boundaries.realBlobOperationsPerformed, 0);
  assert.equal(report.boundaries.productionActivationPerformed, false);
  assert.equal(report.boundaries.stablePromotionAuthorized, false);
});

test('生产环境模板包含全部独立开关且默认关闭', () => {
  const env = parseEnv(read('config/production.env.template'));
  for (const name of [
    'CLOUD_PRODUCTION_ENABLED',
    'CLOUD_PRODUCTION_READ_SYNC_ENABLED',
    'CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED',
    'CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED',
    'CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED',
    'CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED',
    'CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED',
    'CLOUD_PRODUCTION_EXPORT_ENABLED',
    'CLOUD_ADMIN_PRODUCTION_ENABLED',
    'CLOUD_PRODUCTION_BOOTSTRAP_ENABLED',
  ]) assert.equal(env.get(name), '0', `${name}必须默认关闭`);
  assert.equal(env.get('CLOUD_PRODUCTION_PUBLIC_ORIGIN'), '');
  assert.equal(env.get('CLOUD_ADMIN_PUBLIC_ORIGIN'), '');
  assert.equal(env.get('CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION'), '');
});

test('离线生成器使用Web Crypto且不具备网络、持久化、Cookie或剪贴板能力', () => {
  const html = read('tools/production-secret-generator.html');
  const js = read('tools/production-secret-generator.js');
  const config = read('tools/production-secret-generator-config.js');
  const combined = `${html}\n${js}\n${config}`;
  assert.match(html, /connect-src 'none'/u);
  assert.match(js, /crypto\.getRandomValues/u);
  assert.match(js, /new Uint8Array\(48\)/u);
  assert.match(js, /pagehide/u);
  assert.match(js, /state\.clear\(\)/u);
  assert.doesNotMatch(combined, /\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon/u);
  assert.doesNotMatch(combined, /localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.clipboard/u);
  assert.doesNotMatch(combined, /<script[^>]+https?:|<link[^>]+https?:/u);
  assert.equal((config.match(/CLOUD_[A-Z0-9_]+(?:PASSWORD|KEY|SECRET|SALT)'/gu) || []).length, 8);
  assert.match(config, /CLOUD_PRODUCTION_ENABLED=0/u);
  assert.match(config, /CLOUD_PRODUCTION_BOOTSTRAP_ENABLED=0/u);
});

test('交接工具与管理员控制台均不进入普通用户三文件产物', () => {
  const prepare = read('scripts/prepare-public-candidate-v1.mjs');
  assert.match(prepare, /index\.html/u);
  assert.match(prepare, /build-manifest\.json/u);
  assert.match(prepare, /pages-release\.json/u);
  assert.doesNotMatch(prepare, /production-secret-generator|admin\/production-console/u);
  const report = JSON.parse(read('dist/production-handoff-v1.json'));
  assert.equal(report.publicArtifactAllowlist.some(name => name.startsWith('admin/') || name.startsWith('tools/')), false);
});

test('交接产物不含临时令牌、真实来源或已启用声明', () => {
  const files = [
    read('dist/production-handoff-v1.json'),
    read('dist/production-owner-actions-v1.md'),
    read('dist/production-edgeone-env-template-v1.txt'),
  ].join('\n');
  assert.doesNotMatch(files, /eo_token=/iu);
  assert.doesNotMatch(files, /CLOUD_PRODUCTION_ENABLED=1/u);
  assert.doesNotMatch(files, /stablePromotionAuthorized"\s*:\s*true/u);
  assert.match(files, /EdgeOne Makers/u);
  assert.match(files, /首次getStore调用自动创建两个Blob命名空间/u);
});
