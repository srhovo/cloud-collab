import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class PagesVerificationError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'PagesVerificationError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new PagesVerificationError(code, message, details);
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function deploymentBase(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    fail('PAGES_URL_INVALID', '部署地址无效');
  }
  if (url.protocol !== 'https:') fail('PAGES_URL_INVALID', '部署地址必须使用HTTPS');
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function assetUrl(base, filename, nonce) {
  const url = new URL(filename, base);
  url.searchParams.set('release_verify', nonce);
  return url;
}

async function responseBytes(response, label) {
  if (!response?.ok) fail('PAGES_HTTP_FAILURE', `${label}读取失败`, { status: response?.status ?? null });
  return Buffer.from(await response.arrayBuffer());
}

async function verifyOnce({ base, expectedCommitSha, expectedChannel, fetchImpl, nonce }) {
  const releaseResponse = await fetchImpl(assetUrl(base, 'pages-release.json', nonce), { cache: 'no-store' });
  const releaseBytes = await responseBytes(releaseResponse, 'pages-release.json');
  let release;
  try {
    release = JSON.parse(releaseBytes.toString('utf8'));
  } catch {
    fail('PAGES_RELEASE_JSON_INVALID', '线上发布清单JSON无效');
  }
  if (release.schemaVersion !== 1
      || release.channel !== expectedChannel
      || release.sourceCommit !== expectedCommitSha
      || release.productionWriteEnablementIncluded !== false) {
    fail('PAGES_RELEASE_IDENTITY_MISMATCH', '线上发布清单身份不匹配', {
      expectedCommitSha,
      actualCommitSha: release.sourceCommit || null,
    });
  }

  const indexResponse = await fetchImpl(assetUrl(base, 'index.html', nonce), { cache: 'no-store' });
  const indexBytes = await responseBytes(indexResponse, 'index.html');
  if (digest(indexBytes) !== release.sha256 || indexBytes.length !== release.bytes) {
    fail('PAGES_INDEX_HASH_MISMATCH', '线上HTML摘要或字节数不匹配');
  }
  const title = indexBytes.toString('utf8').match(/<title>([^<]+)<\/title>/i)?.[1] || null;
  if (title !== release.title || !title?.includes(release.candidateVersion)) {
    fail('PAGES_TITLE_MISMATCH', '线上HTML标题与发布清单不匹配', { title });
  }

  const manifestResponse = await fetchImpl(assetUrl(base, 'build-manifest.json', nonce), { cache: 'no-store' });
  const manifestBytes = await responseBytes(manifestResponse, 'build-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('PAGES_MANIFEST_JSON_INVALID', '线上构建清单JSON无效');
  }
  if (digest(manifestBytes) !== release.buildManifestSha256
      || manifest.version !== release.candidateVersion
      || manifest.protocolCompatibilityVersion !== release.protocolCompatibilityVersion
      || manifest.sha256 !== release.sha256
      || manifest.bytes !== release.bytes) {
    fail('PAGES_MANIFEST_MISMATCH', '线上构建清单与发布清单不匹配');
  }

  return Object.freeze({
    status: 'verified',
    url: base.href,
    sourceCommit: release.sourceCommit,
    candidateVersion: release.candidateVersion,
    sha256: release.sha256,
    bytes: release.bytes,
  });
}

export async function verifyPagesDeployment({
  url,
  expectedCommitSha,
  expectedChannel = 'github-pages-backup',
  fetchImpl = globalThis.fetch,
  attempts = 6,
  retryDelayMs = 5000,
} = {}) {
  const base = deploymentBase(url);
  const commit = String(expectedCommitSha || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('PAGES_COMMIT_INVALID', '必须提供40位预期Git提交SHA');
  if (!['github-pages-backup', 'edgeone-primary'].includes(expectedChannel)) {
    fail('PAGES_CHANNEL_INVALID', '预期部署通道无效');
  }
  if (typeof fetchImpl !== 'function') fail('PAGES_FETCH_MISSING', '当前运行时不支持fetch');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 12) fail('PAGES_ATTEMPTS_INVALID', '重试次数无效');

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyOnce({
        base,
        expectedCommitSha: commit,
        expectedChannel,
        fetchImpl,
        nonce: `${commit.slice(0, 12)}-${attempt}-${Date.now()}`,
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(retryDelayMs);
    }
  }
  fail('PAGES_VERIFY_FAILED', '线上部署在重试窗口内未通过一致性验证', {
    causeCode: lastError?.code || null,
    causeMessage: lastError?.message || String(lastError),
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function run() {
  const result = await verifyPagesDeployment({
    url: argumentValue('--url'),
    expectedCommitSha: argumentValue('--expected-commit') || process.env.GITHUB_SHA,
    expectedChannel: argumentValue('--expected-channel') || 'github-pages-backup',
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
