import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(root, 'scripts', 'verify-node-test-summary-v1.mjs');

function runVerifier(log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-summary-'));
  const file = path.join(dir, 'ci.log');
  fs.writeFileSync(file, log, 'utf8');
  const result = spawnSync(process.execPath, [verifier, file], { cwd: root, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

function summary({ tests = 10, pass = 10, fail = 0, cancelled = 0 } = {}) {
  return [
    `# tests ${tests}`,
    `# pass ${pass}`,
    `# fail ${fail}`,
    `# cancelled ${cancelled}`,
    '# skipped 0',
    '# todo 0',
    '',
  ].join('\n');
}

test('接受零失败总结', () => {
  const result = runVerifier(summary());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).fail, 0);
});

test('拒绝失败和取消', () => {
  assert.equal(runVerifier(summary({ pass: 9, fail: 1 })).status, 1);
  assert.equal(runVerifier(summary({ pass: 9, cancelled: 1 })).status, 1);
});

test('拒绝缺失总结和零测试', () => {
  assert.equal(runVerifier('command finished\n').status, 2);
  assert.equal(runVerifier(summary({ tests: 0, pass: 0 })).status, 2);
});

test('使用最后一个Node总结', () => {
  const result = runVerifier(`${summary({ tests: 2, pass: 1, fail: 1 })}\n${summary({ tests: 12, pass: 12 })}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).tests, 12);
});
