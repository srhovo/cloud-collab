import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('8.2.31候选显示club但保留内部groupId协议并阻止中文ID', () => {
  const html = read('dist/index.html');
  const manifest = JSON.parse(read('dist/build-manifest.json'));

  assert.match(html, /<title>码单器8\.2\.31（公共协作发布候选版）<\/title>/);
  assert.equal((html.match(/const APP_VERSION = '8\.2\.31';/g) || []).length >= 1, true);
  assert.equal(html.includes('placeholder="例如：下雪"'), true);
  assert.equal(html.includes('placeholder="例如：小雪"'), false);
  assert.equal(html.includes('<label for="cloudGroupIdInput">club</label>'), true);
  assert.equal(html.includes('placeholder="club_id"'), true);
  assert.equal(html.includes('ID 仅支持小写英文字母、数字和下划线，不支持中文'), true);
  assert.equal(html.includes('const ids = [\'cloudGroupIdInput\', \'cloudLibraryIdInput\'];'), true);
  assert.equal(html.includes('const allowed = /^[a-z0-9_]+$/;'), true);
  assert.equal(html.includes('id="cloudGroupIdInput"'), true, '内部DOM和协议兼容锚点必须保留');

  assert.equal(manifest.version, '8.2.31');
  assert.equal(manifest.clubDisplayLabelEnabled, true);
  assert.equal(manifest.legacyGroupIdProtocolRetained, true);
  assert.equal(manifest.identifierAsciiValidationEnabled, true);
  assert.equal(manifest.nicknameExample, '下雪');
  assert.equal(manifest.publicJsonUtf8CharsetRequired, true);
  assert.equal(manifest.stablePromotionPerformed, false);
});

test('EdgeOne对两个公开JSON显式声明UTF-8字符集', () => {
  const config = JSON.parse(read('edgeone.json'));
  for (const source of ['/build-manifest.json', '/pages-release.json']) {
    const rule = config.headers.find(item => item.source === source);
    assert.ok(rule, `缺少${source}响应头规则`);
    const contentType = rule.headers.find(item => String(item.key).toLowerCase() === 'content-type');
    assert.equal(String(contentType?.value).toLowerCase(), 'application/json; charset=utf-8');
  }
});

test('8.2.31仍未获稳定晋升或正式写入授权', () => {
  const ledger = JSON.parse(read('release/release-closure-ledger-v1.json'));
  assert.equal(ledger.currentCompatibleCandidateVersion, '8.2.31');
  assert.equal(ledger.candidateVersionDecision, '8.2.31');
  assert.equal(ledger.releasePolicy.stablePromotionAuthorized, false);
  assert.equal(ledger.releasePolicy.stablePromotionPerformed, false);
  assert.equal(ledger.releasePolicy.productionWriteEnablementIncluded, false);
});
