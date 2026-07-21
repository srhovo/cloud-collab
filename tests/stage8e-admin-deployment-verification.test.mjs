import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ADMIN_CONSOLE_FILES } from '../scripts/prepare-admin-console-v1.mjs';
import { verifyAdminDeployment } from '../scripts/verify-admin-deployment-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://admin.example.invalid';
const COMMIT = 'a'.repeat(40);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceDefinitions = [
  ['admin/production-console.html', 'index.html', 'text/html; charset=utf-8'],
  ['admin/production-console.css', 'production-console.css', 'text/css; charset=utf-8'],
  ['admin/production-console.js', 'production-console.js', 'application/javascript; charset=utf-8'],
];

const CSP = [
  "default-src 'none'",
  "connect-src 'self'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(contentType, overrides = {}) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Security-Policy': CSP,
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Type': contentType,
    ...overrides,
  };
}

function deploymentFixture({
  sourceCommit = COMMIT,
  mutateRelease,
  mutateAsset,
  mutateHeaders,
  exposedPublicFile = null,
} = {}) {
  const assets = new Map();
  const sourceFiles = sourceDefinitions.map(([sourcePath, outputFile, contentType]) => {
    let bytes = fs.readFileSync(path.join(root, sourcePath));
    if (mutateAsset) bytes = Buffer.from(mutateAsset(outputFile, Buffer.from(bytes)) || bytes);
    assets.set(outputFile, { bytes, contentType });
    const sourceBytes = fs.readFileSync(path.join(root, sourcePath));
    return {
      sourcePath,
      outputFile,
      sha256: digest(sourceBytes),
      bytes: sourceBytes.length,
    };
  });

  const release = {
    schemaVersion: 1,
    kind: 'production_admin_console_artifact',
    deploymentStatus: 'code_complete_not_deployed',
    sourceCommit,
    title: '码单器正式管理员控制台',
    sourceFiles,
    outputFiles: ADMIN_CONSOLE_FILES,
    projectConfigTemplate: 'config/edgeone-admin.project.json',
    intendedOriginEnv: 'CLOUD_ADMIN_PUBLIC_ORIGIN',
    requiresSeparateAdministratorOrigin: true,
    requiresProductionAdminSession: true,
    platformResponseHeadersRequired: true,
    includesOrdinaryUserCandidate: false,
    includesSecretValues: false,
    productionCapabilitiesDefaultOff: true,
    frozenPublicCandidate: {
      version: '8.2.31',
      sha256: '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b',
    },
    stableVersion: '8.2.25',
    stablePromotionAuthorized: false,
    stablePromotionPerformed: false,
    productionWriteEnablementIncluded: false,
  };
  if (mutateRelease) mutateRelease(release);
  assets.set('admin-release.json', {
    bytes: Buffer.from(`${JSON.stringify(release, null, 2)}\n`, 'utf8'),
    contentType: 'application/json; charset=utf-8',
  });

  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const filename = parsed.pathname.replace(/^\//u, '');
    requests.push({ filename, options, nonce: parsed.searchParams.get('admin_verify') });
    if (filename === 'build-manifest.json' || filename === 'pages-release.json') {
      return new Response(exposedPublicFile === filename ? '{}' : 'not found', {
        status: exposedPublicFile === filename ? 200 : 404,
        headers: exposedPublicFile === filename
          ? securityHeaders('application/json; charset=utf-8')
          : { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    const asset = assets.get(filename);
    if (!asset) return new Response('not found', { status: 404 });
    const headers = securityHeaders(asset.contentType, mutateHeaders?.(filename) || {});
    headers['Content-Length'] = String(asset.bytes.length);
    return new Response(asset.bytes, { status: 200, headers });
  };
  return { fetchImpl, requests, release, assets };
}

async function expectFailure(options, causeCode) {
  await assert.rejects(
    () => verifyAdminDeployment({
      url: ORIGIN,
      expectedCommitSha: COMMIT,
      attempts: 1,
      retryDelayMs: 0,
      ...options,
    }),
    error => error.code === 'ADMIN_DEPLOYMENT_VERIFY_FAILED'
      && error.details?.causeCode === causeCode,
  );
}

test('管理员线上验证器核对四文件、逐文件摘要、平台响应头和普通文件排除', async () => {
  const fixture = deploymentFixture();
  const result = await verifyAdminDeployment({
    url: ORIGIN,
    expectedCommitSha: COMMIT,
    fetchImpl: fixture.fetchImpl,
    attempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(result.status, 'verified_admin_static_deployment_not_runtime_activation');
  assert.equal(result.origin, ORIGIN);
  assert.equal(result.sourceCommit, COMMIT);
  assert.equal(result.files.length, 3);
  assert.equal(result.platformSecurityHeadersVerified, true);
  assert.equal(result.ordinaryUserCandidateFilesExcluded, true);
  assert.equal(result.runtimeActivationVerified, false);
  assert.equal(result.productionWriteEnablementIncluded, false);
  assert.equal(result.stablePromotionPerformed, false);
  assert.deepEqual(fixture.requests.map(item => item.filename), [
    'admin-release.json',
    'index.html',
    'production-console.css',
    'production-console.js',
    'build-manifest.json',
    'pages-release.json',
  ]);
  for (const request of fixture.requests) {
    assert.equal(request.options.cache, 'no-store');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.referrerPolicy, 'no-referrer');
    assert.match(request.nonce, /^[a-f0-9]{12}-1-\d+$/u);
  }
});

test('管理员线上验证器拒绝HTTP、路径、凭据和临时令牌地址', async () => {
  for (const url of [
    'http://admin.example.invalid',
    'https://admin.example.invalid/path',
    'https://user:pass@admin.example.invalid',
    'https://admin.example.invalid/?eo_token=temporary',
    'https://admin.example.invalid/#fragment',
  ]) {
    await assert.rejects(
      () => verifyAdminDeployment({ url, expectedCommitSha: COMMIT, attempts: 1, retryDelayMs: 0 }),
      error => error.code === 'ADMIN_DEPLOYMENT_URL_INVALID',
    );
  }
});

test('管理员线上验证器拒绝提交错配和清单边界放宽', async () => {
  const wrongCommit = deploymentFixture({ sourceCommit: 'b'.repeat(40) });
  await expectFailure({ fetchImpl: wrongCommit.fetchImpl }, 'ADMIN_DEPLOYMENT_RELEASE_IDENTITY_MISMATCH');

  const secretBoundary = deploymentFixture({ mutateRelease: release => { release.includesSecretValues = true; } });
  await expectFailure({ fetchImpl: secretBoundary.fetchImpl }, 'ADMIN_DEPLOYMENT_RELEASE_IDENTITY_MISMATCH');
});

test('管理员线上验证器拒绝缺失CSP、HSTS或UTF-8内容类型', async () => {
  const badCsp = deploymentFixture({
    mutateHeaders: filename => filename === 'production-console.js'
      ? { 'Content-Security-Policy': "default-src 'none'" }
      : {},
  });
  await expectFailure({ fetchImpl: badCsp.fetchImpl }, 'ADMIN_DEPLOYMENT_CSP_INVALID');

  const badHsts = deploymentFixture({ mutateHeaders: () => ({ 'Strict-Transport-Security': 'max-age=60' }) });
  await expectFailure({ fetchImpl: badHsts.fetchImpl }, 'ADMIN_DEPLOYMENT_HSTS_INVALID');

  const badCharset = deploymentFixture({
    mutateHeaders: filename => filename === 'index.html' ? { 'Content-Type': 'text/html' } : {},
  });
  await expectFailure({ fetchImpl: badCharset.fetchImpl }, 'ADMIN_DEPLOYMENT_CONTENT_TYPE_INVALID');
});

test('管理员线上验证器拒绝文件篡改和普通候选清单泄漏', async () => {
  const tampered = deploymentFixture({
    mutateAsset: (filename, bytes) => filename === 'production-console.css'
      ? Buffer.concat([bytes, Buffer.from('\n/* tampered */\n')])
      : bytes,
  });
  await expectFailure({ fetchImpl: tampered.fetchImpl }, 'ADMIN_DEPLOYMENT_ASSET_HASH_MISMATCH');

  const exposed = deploymentFixture({ exposedPublicFile: 'pages-release.json' });
  await expectFailure({ fetchImpl: exposed.fetchImpl }, 'ADMIN_DEPLOYMENT_PUBLIC_FILE_EXPOSED');
});

test('管理员线上验证器重试后可接受最终一致部署', async () => {
  const fixture = deploymentFixture();
  let calls = 0;
  const fetchImpl = async (...args) => {
    calls += 1;
    if (calls === 1) return new Response('warming', { status: 503 });
    return fixture.fetchImpl(...args);
  };
  const result = await verifyAdminDeployment({
    url: ORIGIN,
    expectedCommitSha: COMMIT,
    fetchImpl,
    attempts: 2,
    retryDelayMs: 0,
  });
  assert.equal(result.sourceCommit, COMMIT);
  assert.equal(calls, 7);
});
