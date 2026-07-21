import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_CONSOLE_FILES,
  ADMIN_CONSOLE_OUTPUT,
  ADMIN_CONSOLE_SOURCE,
  prepareAdminConsole,
} from '../scripts/prepare-admin-console-v1.mjs';
import { PUBLIC_CANDIDATE_FILES } from '../scripts/prepare-public-candidate-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, ADMIN_CONSOLE_SOURCE);
const outputPath = path.join(root, ADMIN_CONSOLE_OUTPUT);
const source = fs.readFileSync(sourcePath, 'utf8');

const REQUIRED_ENDPOINTS = [
  '/api/admin/auth/login', '/api/admin/auth/session', '/api/admin/auth/logout',
  '/api/admin/reviews', '/api/admin/reviews/approve', '/api/admin/reviews/reject',
  '/api/admin/reviews/edit-and-approve', '/api/admin/ordinary-reviews',
  '/api/admin/ordinary-reviews/approve', '/api/admin/ordinary-reviews/reject',
  '/api/admin/ordinary-reviews/edit-and-approve', '/api/admin/sensitive-reviews',
  '/api/admin/sensitive-reviews/detail', '/api/admin/sensitive-reviews/approve',
  '/api/admin/sensitive-reviews/reject', '/api/admin/sensitive-reviews/edit-and-approve',
  '/api/admin/devices', '/api/admin/devices/detail',
  '/api/admin/rollbacks', '/api/admin/rollbacks/execute',
  '/api/admin/exports/summary', '/api/admin/exports/download',
];

const REQUIRED_DEVICE_ACTIONS = ['trust', 'revoke-trust', 'block', 'unblock'];

const REQUIRED_CONFIRMATIONS = [
  "confirmation:'APPROVE'", "confirmation:'REJECT'", "confirmation:'EDIT_AND_APPROVE'",
  "confirmation:'APPROVE_ORDINARY'", "confirmation:'REJECT_ORDINARY'",
  "confirmation:'EDIT_AND_APPROVE_ORDINARY'", "confirmation:'APPROVE_SENSITIVE'",
  "confirmation:'REJECT_SENSITIVE'", "confirmation:'EDIT_AND_APPROVE_SENSITIVE'",
  "confirmation:'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE'",
  "confirmation:'EXPORT_FULL_PUBLIC_DATABASE'",
];

test('正式管理员控制台保持单文件CSP与无持久化凭据边界', () => {
  assert.match(source, /<title>码单器正式管理员控制台<\/title>/u);
  assert.match(source, /default-src 'none'/u);
  assert.match(source, /connect-src 'self'/u);
  assert.match(source, /frame-ancestors 'none'/u);
  assert.equal((source.match(/<script>/gu) || []).length, 1);
  assert.equal((source.match(/<style>/gu) || []).length, 1);
  assert.doesNotMatch(source, /<script\s+src=|<link\s+rel=["']stylesheet/u);
  assert.doesNotMatch(source, /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/u);
  assert.doesNotMatch(source, /eo_token|eo_time|admin-preview\.html/u);
  assert.match(source, /els\.password\.value=''/u);
  assert.match(source, /window\.addEventListener\('pagehide'/u);
  assert.match(source, /credentials:'same-origin'/u);
  assert.match(source, /cache:'no-store'/u);
  assert.match(source, /redirect:'error'/u);
  assert.match(source, /referrerPolicy:'no-referrer'/u);
});

test('正式管理员控制台只调用既有正式管理员API与冻结确认词', () => {
  for (const endpoint of REQUIRED_ENDPOINTS) assert.ok(source.includes(endpoint), endpoint);
  assert.match(source, /`\/api\/admin\/devices\/\$\{action\}`/u);
  for (const action of REQUIRED_DEVICE_ACTIONS) {
    assert.ok(source.includes(`mutateDevice('${action}'`), action);
  }
  for (const confirmation of REQUIRED_CONFIRMATIONS) assert.ok(source.includes(confirmation), confirmation);
  const inline = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/u)?.[1];
  assert.ok(inline);
  assert.doesNotThrow(() => new vm.Script(inline));
});

test('401、退出和页面隐藏统一清空管理员业务数据', () => {
  assert.match(source, /if\(isAuthError\(error\.code,response\.status\)\)setLoggedOut\('会话失效'\)/u);
  assert.match(source, /function setLoggedOut\([^)]*\)\{[^}]*clearBusinessData\(\)/u);
  assert.match(source, /state\.sensitiveDetails\.clear\(\)/u);
  assert.match(source, /state\.selectedDeviceRef=''/u);
  assert.match(source, /revokeDownload\(\)/u);
  assert.match(source, /els\.exactList,els\.ordinaryList,els\.sensitiveList,els\.devicesList,els\.rollbackList/u);
});

test('管理员控制台要求生产投影且稳定晋升保持未授权', () => {
  assert.match(source, /caps\.productionAdmin!==true/u);
  assert.match(source, /caps\.syntheticFixtureOnly!==false/u);
  assert.match(source, /data\?\.stablePromotionAuthorized!==false/u);
  assert.match(source, /稳定版仍为8\.2\.25/u);
  assert.doesNotMatch(source, /const APP_VERSION\s*=|码单器8\.3\.0/u);
});

test('普通用户与管理员产物文件范围双向隔离', () => {
  assert.deepEqual(PUBLIC_CANDIDATE_FILES, ['index.html', 'build-manifest.json', 'pages-release.json']);
  assert.deepEqual(ADMIN_CONSOLE_FILES, ['index.html', 'admin-release.json']);
  assert.equal(PUBLIC_CANDIDATE_FILES.includes('admin-release.json'), false);
  assert.equal(ADMIN_CONSOLE_FILES.includes('build-manifest.json'), false);
  assert.equal(ADMIN_CONSOLE_FILES.includes('pages-release.json'), false);

  fs.rmSync(outputPath, { recursive: true, force: true });
  try {
    const result = prepareAdminConsole({ root, commitSha: 'a'.repeat(40) });
    assert.deepEqual(result.files, ['admin-release.json', 'index.html']);
    assert.deepEqual(fs.readdirSync(outputPath).sort(), ['admin-release.json', 'index.html']);
    assert.equal(fs.readFileSync(path.join(outputPath, 'index.html'), 'utf8'), source);
    const release = JSON.parse(fs.readFileSync(path.join(outputPath, 'admin-release.json'), 'utf8'));
    assert.equal(release.kind, 'production_admin_console_artifact');
    assert.equal(release.sourceCommit, 'a'.repeat(40));
    assert.equal(release.requiresSeparateAdministratorOrigin, true);
    assert.equal(release.includesOrdinaryUserCandidate, false);
    assert.equal(release.includesSecretValues, false);
    assert.equal(release.productionCapabilitiesDefaultOff, true);
    assert.equal(release.stableVersion, '8.2.25');
    assert.equal(release.candidateVersion, '8.2.31');
    assert.equal(release.stablePromotionAuthorized, false);
    assert.equal(release.stablePromotionPerformed, false);
    assert.equal(release.productionWriteEnablementIncluded, false);
    assert.match(release.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(release.bytes, Buffer.byteLength(source, 'utf8'));
  } finally {
    fs.rmSync(outputPath, { recursive: true, force: true });
  }
});

test('管理员产物构建器拒绝错误输出目录和无效提交SHA', () => {
  assert.throws(
    () => prepareAdminConsole({ root, outputDirectory: path.join(root, '.edgeone-artifact'), commitSha: 'b'.repeat(40) }),
    error => error.code === 'ADMIN_CONSOLE_OUTPUT_UNSAFE',
  );
  assert.throws(
    () => prepareAdminConsole({ root, commitSha: 'short' }),
    error => error.code === 'ADMIN_CONSOLE_COMMIT_INVALID',
  );
});
