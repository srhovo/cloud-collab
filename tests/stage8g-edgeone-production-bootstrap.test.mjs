import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sanitizeFailureMessage } from '../scripts/run-edgeone-production-bootstrap-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = 'scripts/run-edgeone-production-bootstrap-v1.mjs';
const workflow = '.github/workflows/stage8g-edgeone-production-bootstrap.yml';
const apiValue = `value-${'x'.repeat(40)}`;
const unlockValue = `unlock-${'y'.repeat(40)}`;

function run(args = [], env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function execution(overrides = {}) {
  return {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    BOOTSTRAP_APPROVAL_ENVIRONMENT: 'production-bootstrap',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: 'INITIALIZE-see-see_cz-V1',
    BOOTSTRAP_IMPACT_ACKNOWLEDGEMENT: 'WRITE-10-IMMUTABLE-OBJECTS',
    EDGEONE_PROJECT_ID: 'pages-testproject',
    EDGEONE_API_TOKEN: apiValue,
    EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK: unlockValue,
    ...overrides,
  };
}

test('阶段8H计划保持10项与零远端操作', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.stage, '8H');
  assert.equal(data.operation, 'plan');
  assert.equal(data.resourceCount, 10);
  assert.equal(data.executionBranchRequired, 'refs/heads/main');
  assert.equal(data.approvalEnvironmentRequired, 'production-bootstrap');
  assert.equal(data.realBlobReadsPerformed, 0);
  assert.equal(data.realBlobWritesPerformed, 0);
  assert.equal(data.realBlobDeletesPerformed, 0);
  assert.equal(data.stablePromotionAuthorized, false);
});

test('计划模式不输出已配置值', () => {
  const result = run([], execution());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).executionUnlockConfigured, true);
  assert.doesNotMatch(result.stdout, new RegExp(apiValue, 'u'));
  assert.doesNotMatch(result.stdout, new RegExp(unlockValue, 'u'));
});

test('执行上下文必须是手动main和审批环境', () => {
  for (const [overrides, code] of [
    [{ GITHUB_EVENT_NAME: 'push' }, 'BOOTSTRAP_EVENT_INVALID'],
    [{ GITHUB_REF: 'refs/heads/feature' }, 'BOOTSTRAP_BRANCH_INVALID'],
    [{ BOOTSTRAP_APPROVAL_ENVIRONMENT: '' }, 'BOOTSTRAP_APPROVAL_ENVIRONMENT_INVALID'],
  ]) {
    const result = run(['--execute'], execution(overrides));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(code, 'u'));
  }
});

test('执行要求双确认和独立随机解锁值', () => {
  for (const [overrides, code] of [
    [{ CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: 'wrong' }, 'BOOTSTRAP_CONFIRMATION_INVALID'],
    [{ BOOTSTRAP_IMPACT_ACKNOWLEDGEMENT: 'wrong' }, 'BOOTSTRAP_IMPACT_ACKNOWLEDGEMENT_INVALID'],
    [{ EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK: '' }, 'BOOTSTRAP_EXECUTION_LOCKED'],
    [{ EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK: apiValue }, 'BOOTSTRAP_EXECUTION_VALUE_REUSED'],
  ]) {
    const result = run(['--execute'], execution(overrides));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(code, 'u'));
    assert.doesNotMatch(result.stderr, new RegExp(apiValue, 'u'));
  }
});

test('失败脱敏覆盖API值、项目ID和执行解锁值', () => {
  const projectId = 'pages-hiddenproject';
  const safe = sanitizeFailureMessage(
    `Authorization: Bearer ${apiValue}; token=${apiValue}; project=${projectId}; execution_unlock=${unlockValue}`,
    { token: apiValue, projectId, executionUnlock: unlockValue },
  );
  assert.doesNotMatch(safe, new RegExp(apiValue, 'u'));
  assert.doesNotMatch(safe, new RegExp(projectId, 'u'));
  assert.doesNotMatch(safe, new RegExp(unlockValue, 'u'));
  assert.match(safe, /\[REDACTED\]/u);
});

test('工作流要求main、环境审批、双确认和独立解锁', () => {
  const text = fs.readFileSync(path.join(root, workflow), 'utf8');
  assert.match(text, /workflow_dispatch:/u);
  assert.match(text, /impact_acknowledgement:/u);
  assert.match(text, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(text, /environment:\s*production-bootstrap/u);
  assert.match(text, /EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK/u);
  assert.match(text, /timeout-minutes:\s*10/u);
  assert.match(text, /cancel-in-progress:\s*false/u);
  assert.doesNotMatch(text, /^\s*(push|pull_request|schedule):/mu);
});
