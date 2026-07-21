import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PUBLIC_CANDIDATE_FILES } from '../scripts/prepare-public-candidate-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('admin/production-console.html');
const css = read('admin/production-console.css');
const js = read('admin/production-console.js');

function includesAll(source, values, label) {
  for (const value of values) assert.ok(source.includes(value), `${label} missing ${value}`);
}

function excludesAll(source, values, label) {
  for (const value of values) assert.ok(!source.includes(value), `${label} unexpectedly contains ${value}`);
}

test('正式控制台只加载同源外部资源并冻结严格CSP', () => {
  assert.match(html, /<html lang="zh-CN">/u);
  assert.match(html, /Content-Security-Policy/u);
  includesAll(html, [
    "default-src 'none'", "connect-src 'self'", "style-src 'self'", "script-src 'self'",
    "object-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'",
    '<link rel="stylesheet" href="./production-console.css">',
    '<script src="./production-console.js" defer></script>',
  ], 'admin console html');
  assert.equal((html.match(/<script/gu) || []).length, 1);
  assert.equal((html.match(/<style/gu) || []).length, 0);
  assert.doesNotMatch(html, /https?:\/\//u);
  assert.ok(css.length > 1000);
  assert.doesNotMatch(css, /url\s*\(/iu);
});

test('正式控制台覆盖全部已接线管理员API与冻结确认词', () => {
  includesAll(js, [
    '/api/admin/auth/login', '/api/admin/auth/session', '/api/admin/auth/logout',
    '/api/admin/reviews', '/api/admin/reviews/approve', '/api/admin/reviews/reject', '/api/admin/reviews/edit-and-approve',
    '/api/admin/ordinary-reviews', '/api/admin/ordinary-reviews/approve', '/api/admin/ordinary-reviews/reject', '/api/admin/ordinary-reviews/edit-and-approve',
    '/api/admin/sensitive-reviews', '/api/admin/sensitive-reviews/detail?id=', '/api/admin/sensitive-reviews/approve', '/api/admin/sensitive-reviews/reject', '/api/admin/sensitive-reviews/edit-and-approve',
    '/api/admin/devices', '/api/admin/devices/detail?id=', '/api/admin/devices/${action}',
    '/api/admin/rollbacks', '/api/admin/rollbacks/execute',
    '/api/admin/exports/summary', '/api/admin/exports/download',
    "confirmation: 'APPROVE'", "confirmation: 'REJECT'", "confirmation: 'EDIT_AND_APPROVE'",
    "confirmation: 'APPROVE_ORDINARY'", "confirmation: 'REJECT_ORDINARY'", "confirmation: 'EDIT_AND_APPROVE_ORDINARY'",
    "confirmation: 'APPROVE_SENSITIVE'", "confirmation: 'REJECT_SENSITIVE'", "confirmation: 'EDIT_AND_APPROVE_SENSITIVE'",
    "confirmation: 'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE'", "confirmation: 'EXPORT_FULL_PUBLIC_DATABASE'",
    "randomId('dgrq_v1_')", "randomId('rbrq_v1_')", "randomId('exrq_v1_')",
  ], 'admin console script');
});

test('导出控制台使用阶段8B正式摘要和响应头契约', () => {
  includesAll(js, [
    'const result = data.summary', 'result.byteLength',
    "x-cloud-collab-package-id", "x-cloud-collab-public-version",
    "x-cloud-collab-stable-promotion-authorized", "!== '0'",
    "Content-Type': 'application/json'", "startsWith('application/zip')",
  ], 'export integration');
  excludesAll(js, ['x-mdq-', 'packageByteLength', 'data.result || data; renderExport'], 'obsolete export integration');
});

test('控制台不保存凭据并只使用同源无缓存请求', () => {
  includesAll(js, [
    "credentials: 'same-origin'", "cache: 'no-store'", "redirect: 'error'", "referrerPolicy: 'no-referrer'",
    "els.password.value = ''", "window.addEventListener('pagehide'", 'clearBusinessData()',
    'caps.productionAdmin !== true', 'caps.syntheticFixtureOnly !== false', 'stablePromotionAuthorized !== false',
    'sensitiveSubmissionIntakeEnabled === false',
  ], 'privacy boundary');
  excludesAll(js, [
    'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'innerHTML', 'outerHTML',
    'deviceToken', 'adminToken', 'Authorization', 'CLOUD_ADMIN_PASSWORD', 'CLOUD_ADMIN_SESSION_SECRET',
    'http://', 'https://', 'eval(', 'new Function(',
  ], 'privacy boundary');
});

test('管理员控制台永不进入普通用户三文件候选产物', () => {
  assert.deepEqual([...PUBLIC_CANDIDATE_FILES], ['index.html', 'build-manifest.json', 'pages-release.json']);
  for (const file of ['admin/production-console.html', 'admin/production-console.css', 'admin/production-console.js']) {
    assert.ok(!PUBLIC_CANDIDATE_FILES.includes(file));
  }
  const prepare = read('scripts/prepare-public-candidate-v1.mjs');
  assert.doesNotMatch(prepare, /admin\/production-console/u);
});

test('README同步到阶段8C并保留冻结候选发布门禁', () => {
  const readme = read('README.md');
  includesAll(readme, [
    '阶段8C', '正式管理员控制台', '不部署',
    '阶段7J', '8.2.31', '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b',
    '稳定版8.2.25未晋升', '正式公共写入保持关闭',
  ], 'README');
});
