import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_INTERNAL_PREFIX,
  PRODUCTION_ADMIN_HOSTNAME,
  PRODUCTION_PUBLIC_HOSTNAME,
  config,
  middleware,
  productionHostDecision,
} from '../middleware.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function url(hostname, pathname = '/') {
  return `https://${hostname}${pathname}`;
}

test('普通域名只允许普通静态与普通API', () => {
  for (const pathname of ['/', '/index.html', '/api/public/version', '/api/device/register', '/api/submissions/create']) {
    assert.deepEqual(productionHostDecision(url(PRODUCTION_PUBLIC_HOSTNAME, pathname)), {
      action: 'next',
      surface: 'public',
    });
  }
  for (const pathname of ['/api/admin/auth/login', '/api/admin/reviews', '/__admin/index.html', '/production-console.js', '/admin-release.json']) {
    const decision = productionHostDecision(url(PRODUCTION_PUBLIC_HOSTNAME, pathname));
    assert.equal(decision.action, 'deny');
    assert.equal(decision.status, 404);
  }
});

test('管理员域名只允许管理员同源静态与管理员API', () => {
  assert.equal(productionHostDecision(url(PRODUCTION_ADMIN_HOSTNAME, '/')).destination, '/__admin/index.html');
  assert.equal(productionHostDecision(url(PRODUCTION_ADMIN_HOSTNAME, '/index.html')).destination, '/__admin/index.html');
  assert.equal(productionHostDecision(url(PRODUCTION_ADMIN_HOSTNAME, '/production-console.css')).destination, '/__admin/production-console.css');
  assert.equal(productionHostDecision(url(PRODUCTION_ADMIN_HOSTNAME, '/production-console.js')).destination, '/__admin/production-console.js');
  assert.equal(productionHostDecision(url(PRODUCTION_ADMIN_HOSTNAME, '/admin-release.json')).destination, '/__admin/admin-release.json');
  assert.deepEqual(productionHostDecision(url(PRODUCTION_ADMIN_HOSTNAME, '/api/admin/auth/session')), {
    action: 'next',
    surface: 'administrator',
  });

  for (const pathname of ['/api/public/version', '/api/device/register', '/api/submissions/create', '/api/sensitive-submissions/create', '/__admin/index.html', '/unknown']) {
    const decision = productionHostDecision(url(PRODUCTION_ADMIN_HOSTNAME, pathname));
    assert.equal(decision.action, 'deny');
    assert.equal(decision.status, 404);
  }
});

test('未知Host、畸形URL和编码路径失败关闭', () => {
  assert.equal(productionHostDecision('not-a-url').status, 400);
  assert.equal(productionHostDecision(url('preview.example', '/')).status, 421);
  assert.equal(productionHostDecision(url(PRODUCTION_PUBLIC_HOSTNAME, '/%2fapi/admin/auth/login')).status, 400);
  assert.equal(productionHostDecision(url(PRODUCTION_ADMIN_HOSTNAME, '/%5c__admin/index.html')).status, 400);
  assert.equal(ADMIN_INTERNAL_PREFIX, '/__admin');
});

test('中间件对全部路由生效且按决策调用next、rewrite或直接拒绝', async () => {
  assert.deepEqual(config.matcher, ['/:path*']);

  let called = '';
  const publicResult = middleware({
    request: { url: url(PRODUCTION_PUBLIC_HOSTNAME, '/api/public/version') },
    next() { called = 'next'; return 'NEXT'; },
    rewrite() { throw new Error('unexpected rewrite'); },
  });
  assert.equal(publicResult, 'NEXT');
  assert.equal(called, 'next');

  const adminResult = middleware({
    request: { url: url(PRODUCTION_ADMIN_HOSTNAME, '/') },
    next() { throw new Error('unexpected next'); },
    rewrite(destination) { called = destination; return 'REWRITE'; },
  });
  assert.equal(adminResult, 'REWRITE');
  assert.equal(called, '/__admin/index.html');

  const denied = middleware({
    request: { url: url(PRODUCTION_PUBLIC_HOSTNAME, '/api/admin/auth/login') },
    next() { throw new Error('unexpected next'); },
    rewrite() { throw new Error('unexpected rewrite'); },
  });
  assert.equal(denied.status, 404);
  assert.equal(denied.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal((await denied.json()).error.code, 'PUBLIC_HOST_ADMIN_ROUTE_DENIED');
});

test('EdgeOne构建组合普通与管理员产物但仍保持内部目录隔离', () => {
  const builder = read('scripts/prepare-edgeone-single-project-v1.mjs');
  const pkg = JSON.parse(read('package.json'));
  const edgeone = JSON.parse(read('edgeone.json'));

  assert.match(pkg.scripts['edgeone:build'], /edgeone:production:prepare/u);
  assert.match(builder, /preparePublicCandidate/u);
  assert.match(builder, /prepareAdminConsole/u);
  assert.match(builder, /__admin/u);
  assert.match(builder, /accountApiTokenRequiredAtRuntime:\s*false/u);
  assert.equal(edgeone.outputDirectory, './.edgeone-artifact');
  assert.equal(edgeone.headers.some(rule => rule.source === '/__admin/*'), true);
  assert.equal(edgeone.headers.some(rule => rule.source === '/__admin/production-console.js'), true);
});
