import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(root, 'scripts', 'verify-node-test-summary-v1.mjs');

function verify(log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-collab-ci-summary-'));
  const file = path.join(dir, 'ci.log');
  fs.writeFileSync(file, log, 'utf8');
  const result = spawnSync(process.execPath, [verifier, file], {
    cwd: root,
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

function summary({ tests = 10, pass = 10, fail = 0, cancelled = 0, skipped = 0, todo = 0 } = {}) {
  return [
    'TAP version 13',
    '1..10',
    `# tests ${tests}`,
    '# suites 0',
    `# pass ${pass}`,
    `# fail ${fail}`,
    `# cancelled ${cancelled}`,
    `# skipped ${skipped}`,
    `# todo ${todo}`,
    '# duration_ms 100',
    '',
  ].join('\n');
}

test('CI摘要校验器接受明确的零失败Node总结', () => {
  const result = verify(summary());
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload, {
    verified: true,
    tests: 10,
    pass: 10,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  });
});

test('CI摘要校验器拒绝日志中的真实失败或取消', () => {
  const failed = verify(summary({ tests: 10, pass: 9, fail: 1 }));
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /1 failed Node test/u);

  const cancelled = verify(summary({ tests: 10, pass: 9, cancelled: 1 }));
  assert.equal(cancelled.status, 1);
  assert.match(cancelled.stderr, /1 cancelled Node test/u);
});

test('CI摘要校验器拒绝缺失或零测试的伪造日志', () => {
  const missing = verify('npm run ci\ncommand finished\n');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /does not contain a final Node test summary/u);

  const empty = verify(summary({ tests: 0, pass: 0 }));
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /no executed passing tests/u);
});

test('CI摘要校验器使用最后一个完整总结，允许测试自身验证失败样例', () => {
  const nestedFailure = summary({ tests: 2, pass: 1, fail: 1 });
  const outerSuccess = summary({ tests: 12, pass: 12, fail: 0 });
  const result = verify(`${nestedFailure}\n# nested fixture above\n${outerSuccess}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).tests, 12);
});
