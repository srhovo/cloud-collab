import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'deploy', 'admin', 'edgeone.json'), 'utf8'));

test('管理员edgeone.json使用独立根目录构建与四文件输出', () => {
  assert.equal(config.nodeVersion, '22.11.0');
  assert.equal(config.outputDirectory, './.edgeone-admin-artifact');
  assert.match(config.installCommand, /cp \.\.\/\.\.\/package\.json \.\.\/\.\.\/package-lock\.json/u);
  assert.match(config.installCommand, /npm ci --ignore-scripts/u);
  assert.match(config.buildCommand, /prepare-admin-deployment-root-v1\.mjs/u);
  assert.match(config.buildCommand, /--repository-root \.\.\/\.\./u);
  assert.match(config.buildCommand, /--project-root \./u);
  assert.doesNotMatch(config.buildCommand, /edgeone:build|\.edgeone-artifact/u);
});

test('管理员响应头符合EdgeOne规则并覆盖关键浏览器安全边界', () => {
  assert.equal(Array.isArray(config.headers), true);
  assert.equal(config.headers.length <= 30, true);
  const all = config.headers.flatMap(rule => rule.headers.map(header => ({ source: rule.source, ...header })));
  assert.equal(all.length <= 30, true);
  for (const header of all) {
    assert.match(header.key, /^[A-Za-z0-9-]{1,100}$/u);
    assert.equal(Buffer.byteLength(header.value, 'utf8') <= 1000, true);
    assert.equal(/^[\x20-\x7e]+$/u.test(header.value), true);
  }
  const wildcardRule = config.headers.find(rule => rule.source === '/*');
  assert.ok(wildcardRule);
  const wildcard = Object.fromEntries(wildcardRule.headers.map(item => [item.key.toLowerCase(), item.value]));
  assert.equal(wildcard['cache-control'], 'no-store, max-age=0, must-revalidate');
  assert.match(wildcard['content-security-policy'], /default-src 'none'/u);
  assert.match(wildcard['content-security-policy'], /connect-src 'self'/u);
  assert.match(wildcard['content-security-policy'], /style-src 'self'/u);
  assert.match(wildcard['content-security-policy'], /script-src 'self'/u);
  assert.match(wildcard['content-security-policy'], /frame-ancestors 'none'/u);
  assert.equal(wildcard['strict-transport-security'], 'max-age=31536000');
  assert.equal(wildcard['x-content-type-options'], 'nosniff');
  assert.equal(wildcard['x-frame-options'], 'DENY');
  assert.equal(wildcard['referrer-policy'], 'no-referrer');
  assert.equal(wildcard['cross-origin-opener-policy'], 'same-origin');
  assert.equal(wildcard['cross-origin-resource-policy'], 'same-origin');
  assert.equal(wildcard['x-permitted-cross-domain-policies'], 'none');
  assert.match(wildcard['permissions-policy'], /camera=\(\)/u);
  const releaseRule = config.headers.find(rule => rule.source === '/admin-release.json');
  assert.ok(releaseRule);
  assert.equal(releaseRule.headers[0].value, 'application/json; charset=utf-8');
});

test('管理员与普通用户EdgeOne配置互不覆盖', () => {
  const publicConfig = JSON.parse(fs.readFileSync(path.join(root, 'edgeone.json'), 'utf8'));
  assert.equal(publicConfig.buildCommand, 'npm run edgeone:build');
  assert.equal(publicConfig.outputDirectory, './.edgeone-artifact');
  assert.notEqual(publicConfig.buildCommand, config.buildCommand);
  assert.notEqual(publicConfig.outputDirectory, config.outputDirectory);
  assert.equal(publicConfig.headers.some(rule => rule.source === '/build-manifest.json'), true);
  assert.equal(config.headers.some(rule => rule.source === '/build-manifest.json'), false);
});
