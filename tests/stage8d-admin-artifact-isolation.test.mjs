import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_CONSOLE_FILES,
  prepareAdminConsole,
} from '../scripts/prepare-admin-console-v1.mjs';
import {
  auditAdminProjectConfig,
  verifyAdminPublicArtifactIsolation,
} from '../scripts/verify-admin-public-artifact-isolation-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixtureRoot() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-collab-stage8d-'));
  fs.mkdirSync(path.join(target, 'admin'), { recursive: true });
  fs.mkdirSync(path.join(target, 'config'), { recursive: true });
  for (const file of ['production-console.html', 'production-console.css', 'production-console.js']) {
    fs.copyFileSync(path.join(root, 'admin', file), path.join(target, 'admin', file));
  }
  fs.copyFileSync(
    path.join(root, 'config', 'edgeone-admin.project.json'),
    path.join(target, 'config', 'edgeone-admin.project.json'),
  );
  return target;
}

function createPublicArtifact(target) {
  const directory = path.join(target, '.edgeone-artifact');
  fs.mkdirSync(directory, { recursive: true });
  const index = Buffer.from('<!doctype html><title>码单器8.2.31（公共协作发布候选版）</title>', 'utf8');
  const sha256 = digest(index);
  fs.writeFileSync(path.join(directory, 'index.html'), index);
  fs.writeFileSync(path.join(directory, 'build-manifest.json'), `${JSON.stringify({
    version: '8.2.31',
    sha256,
    bytes: index.length,
  })}\n`, 'utf8');
  fs.writeFileSync(path.join(directory, 'pages-release.json'), `${JSON.stringify({
    candidate: { version: '8.2.31', sha256 },
    stable: { version: '8.2.25', promotionAuthorized: false, promotionPerformed: false },
    productionWriteEnablementIncluded: false,
  })}\n`, 'utf8');
  return directory;
}

function remove(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

test('管理员构建器生成精确四文件并绑定源哈希与未部署边界', () => {
  const target = fixtureRoot();
  try {
    const result = prepareAdminConsole({
      root: target,
      outputDirectory: path.join(target, '.edgeone-admin-artifact'),
      commitSha: 'a'.repeat(40),
    });
    assert.deepEqual([...result.files].sort(), [...ADMIN_CONSOLE_FILES].sort());
    assert.equal(result.release.deploymentStatus, 'code_complete_not_deployed');
    assert.equal(result.release.sourceCommit, 'a'.repeat(40));
    assert.equal(result.release.sourceFiles.length, 3);
    assert.equal(result.release.includesOrdinaryUserCandidate, false);
    assert.equal(result.release.includesSecretValues, false);
    assert.equal(result.release.productionCapabilitiesDefaultOff, true);
    assert.equal(result.release.frozenPublicCandidate.version, '8.2.31');
    assert.equal(result.release.frozenPublicCandidate.sha256, '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b');
    assert.equal(result.release.stableVersion, '8.2.25');
    assert.equal(result.release.stablePromotionAuthorized, false);
    assert.equal(result.release.stablePromotionPerformed, false);
    assert.equal(result.release.productionWriteEnablementIncluded, false);

    for (const item of result.release.sourceFiles) {
      const source = fs.readFileSync(path.join(target, item.sourcePath));
      const output = fs.readFileSync(path.join(target, '.edgeone-admin-artifact', item.outputFile));
      assert.deepEqual(output, source);
      assert.equal(item.sha256, digest(source));
      assert.equal(item.bytes, source.length);
    }
  } finally {
    remove(target);
  }
});

test('管理员构建器拒绝越界目录和不安全源内容', () => {
  const target = fixtureRoot();
  try {
    assert.throws(
      () => prepareAdminConsole({ root: target, outputDirectory: path.join(target, 'other'), commitSha: 'b'.repeat(40) }),
      error => error.code === 'ADMIN_CONSOLE_OUTPUT_UNSAFE',
    );

    const jsPath = path.join(target, 'admin', 'production-console.js');
    fs.appendFileSync(jsPath, '\nlocalStorage.setItem("x", "y");\n', 'utf8');
    assert.throws(
      () => prepareAdminConsole({ root: target, outputDirectory: path.join(target, '.edgeone-admin-artifact'), commitSha: 'b'.repeat(40) }),
      error => error.code === 'ADMIN_CONSOLE_JS_FORBIDDEN',
    );
  } finally {
    remove(target);
  }
});

test('管理员项目配置模板冻结构建目录、内容类型和平台安全响应头', () => {
  assert.equal(auditAdminProjectConfig({ root }).verified, true);
  const target = fixtureRoot();
  try {
    const configPath = path.join(target, 'config', 'edgeone-admin.project.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const global = config.headers.find(item => item.source === '/*');
    global.headers.find(item => item.key === 'Content-Security-Policy').value = "default-src 'none'";
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    assert.throws(
      () => auditAdminProjectConfig({ root: target }),
      error => error.code === 'ADMIN_PROJECT_CSP_INVALID',
    );
  } finally {
    remove(target);
  }
});

test('管理员四文件与普通用户三文件通过互斥验证', () => {
  const target = fixtureRoot();
  try {
    const adminDirectory = path.join(target, '.edgeone-admin-artifact');
    const publicDirectory = createPublicArtifact(target);
    prepareAdminConsole({ root: target, outputDirectory: adminDirectory, commitSha: 'c'.repeat(40) });
    const result = verifyAdminPublicArtifactIsolation({ root: target, adminDirectory, publicDirectory });
    assert.equal(result.verified, true);
    assert.equal(result.mutuallyExclusive, true);
    assert.notEqual(result.adminIndexSha256, result.publicIndexSha256);
    assert.deepEqual([...result.adminFiles].sort(), [...ADMIN_CONSOLE_FILES].sort());
    assert.deepEqual([...result.publicFiles].sort(), ['build-manifest.json', 'index.html', 'pages-release.json']);
    assert.equal(result.deploymentPerformed, false);
    assert.equal(result.productionWriteEnablementIncluded, false);
    assert.equal(result.stablePromotionAuthorized, false);
  } finally {
    remove(target);
  }
});

test('互斥验证拒绝额外文件和管理员输出篡改', () => {
  const target = fixtureRoot();
  try {
    const adminDirectory = path.join(target, '.edgeone-admin-artifact');
    const publicDirectory = createPublicArtifact(target);
    prepareAdminConsole({ root: target, outputDirectory: adminDirectory, commitSha: 'd'.repeat(40) });

    fs.writeFileSync(path.join(adminDirectory, 'pages-release.json'), '{}\n', 'utf8');
    assert.throws(
      () => verifyAdminPublicArtifactIsolation({ root: target, adminDirectory, publicDirectory }),
      error => error.code === 'ADMIN_ARTIFACT_FILES_INVALID',
    );
    fs.rmSync(path.join(adminDirectory, 'pages-release.json'));

    fs.appendFileSync(path.join(adminDirectory, 'production-console.js'), '\n// tampered\n', 'utf8');
    assert.throws(
      () => verifyAdminPublicArtifactIsolation({ root: target, adminDirectory, publicDirectory }),
      error => error.code === 'ADMIN_SOURCE_OUTPUT_MISMATCH',
    );
  } finally {
    remove(target);
  }
});

test('package保留独立管理员审计命令并将正式EdgeOne构建切换为组合产物', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['admin:prepare'], 'node scripts/prepare-admin-console-v1.mjs');
  assert.equal(pkg.scripts['admin:verify:isolation'], 'node scripts/verify-admin-public-artifact-isolation-v1.mjs');
  assert.equal(pkg.scripts['edgeone:admin:build'], 'npm run ci && npm run admin:prepare -- --output .edgeone-admin-artifact');
  assert.equal(pkg.scripts['edgeone:production:prepare'], 'node scripts/prepare-edgeone-single-project-v1.mjs');
  assert.equal(pkg.scripts['edgeone:build'], 'npm run ci && npm run edgeone:production:prepare -- --output .edgeone-artifact');
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.edgeone-admin-artifact\/$/mu);
});
