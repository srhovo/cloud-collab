import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const operatorPath = path.join(root, 'dist', 'cleanup-preview.html');

function readOperator() {
  return fs.readFileSync(operatorPath, 'utf8');
}

test('一次性清理操作页只使用同源受控路由并保留EdgeOne预览凭据参数', () => {
  const html = readOperator();
  assert.match(html, /new URL\('\/one-shot\/cleanup-preview', window\.location\.origin\)/);
  assert.match(html, /\['eo_token', 'eo_time'\]/);
  assert.match(html, /credentials: 'same-origin'/);
  assert.match(html, /method: 'POST'/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /localStorage|sessionStorage|indexedDB/);
});

test('操作页严格执行先检查后删除并携带摘要', () => {
  const html = readOperator();
  assert.match(html, /action === 'execute'/);
  assert.match(html, /body\.expectedKeySetDigest = inspected\.keySetDigest/);
  assert.match(html, /request\('inspect'\)/);
  assert.match(html, /request\('execute'\)/);
  assert.match(html, /data\.completed !== true \|\| data\.remainingCount !== 0/);
  assert.match(html, /confirmBox\.checked/);
  assert.match(html, /window\.confirm/);
});

test('操作页不内置真实清理密钥且只显示数量结果', () => {
  const html = readOperator();
  assert.match(html, /type="password"/);
  assert.match(html, /CLOUD_PREVIEW_CLEANUP_KEY/);
  assert.doesNotMatch(html, /CLOUD_PREVIEW_CLEANUP_KEY\s*=\s*['"][^'"]+/);
  assert.doesNotMatch(html, /console\.(?:log|error|warn)/);
  assert.doesNotMatch(html, /unsafeKey|rawKey|objectKeys/);
});
