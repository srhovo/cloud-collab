import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnessPath = path.join(root, 'dist', 'client-preview-test.html');
const html = fs.readFileSync(harnessPath, 'utf8');

test('预览验收页只在内存中提供写入门禁', () => {
  assert.match(html, /type="password"/);
  assert.match(html, /let activeKey = ''/);
  assert.match(html, /CloudCollabPreviewRuntime = Object\.freeze/);
  assert.match(html, /getWriteAccess: \(\) => activeKey/);
  assert.doesNotMatch(html, /(?:localStorage|sessionStorage)\s*[.\[]|indexedDB\s*[.(]/);
  assert.doesNotMatch(html, /console\.(?:log|warn|error)/);
});

test('预览验收页兼容EdgeOne参数保留和同源会话两种模式', () => {
  assert.match(html, /\['eo_token', 'eo_time'\]/);
  assert.match(html, /function sameOriginFetch\(input, init = \{\}\)/);
  assert.match(html, /credentials: 'same-origin'/);
  assert.match(html, /child\.fetch = sameOriginFetch/);
  assert.match(html, /url\.origin !== window\.location\.origin/);
  assert.doesNotMatch(html, /当前地址缺少EdgeOne预览访问参数/);
});

test('预览验收页加载的必须是真实8.2.28候选', () => {
  assert.match(html, /cloud-collab-api-base/);
  assert.match(html, /const APP_VERSION = '8\.2\.28';/);
  assert.match(html, /group_fixture \/ lib_receive_fixture/);
  assert.match(html, /frame\.contentWindow\.CloudCollabPreviewRuntime = undefined/);
  assert.match(html, /pagehide/);
});
