import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = 'scripts/run-edgeone-production-bootstrap-v1.mjs';
const workflowPath = '.github/workflows/stage8f-edgeone-production-bootstrap.yml';
const token = `edgeone-token-${'x'.repeat(40)}`;
const unlock = `bootstrap-unlock-${'y'.repeat(40)}`;

function run(args = [], env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function executionEnv(overrides = {}) {
  return {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    BOOTSTRAP_APPROVAL_ENVIRONMENT: 'production-bootstrap',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: 'INITIALIZE-see-see_cz-V1',
    BOOTSTRAP_IMPACT_ACKNOWLEDGEMENT: 'WRITE-10-IMMUTABLE-OBJECTS',
    EDGEONE_PROJECT_ID: 'pages-urtsvuwmfvli',
    EDGEONE_API_TOKEN: token,
    EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK: unlock,
    ...overrides,
  };
}

test('默认模式只生成10项零写入初始化计划', () => {
  const report = 'dist/stage8g-test-bootstrap-plan.json';
  fs.rmSync(path.join(root, report), { force: true });
  const result = run([], { BOOTSTRAP_REPORT_PATH: report });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stage, '8G');
  assert.equal(payload.operation, 'plan');
  assert.equal(payload.status, 'ready_not_executed');
  assert.equal(payload.projectIdConfigured, false);
  assert.equal(payload.apiTokenConfigured, false);
  assert.equal(payload.executionUnlockConfigured, false);
  assert.equal(payload.publicStoreName, 'cloud-collab-production-v1');
  assert.equal(payload.adminStoreName, 'cloud-collab-admin-production-v1');
  assert.equal(payload.resourceCount, 10);
  assert.equal(payload.resources.length, 10);
  assert.equal(payload.confirmationRequired, 'INITIALIZE-see-see_cz-V1');
  assert.equal(payload.impactAcknowledgementRequired, 'WRITE-10-IMMUTABLE-OBJECTS');
  assert.equal(payload.executionBranchRequired, 'refs/heads/main');
  assert.equal(payload.approvalEnvironmentRequired, 'production-bootstrap');
  assert.equal(payload.realSecretValuesExposed, false);
  assert.equal(payload.realBlobReadsPerformed, 0);
  assert.equal(payload.realBlobWritesPerformed, 0);
  assert.equal(payload.realBlobDeletesPerformed, 0);
  assert.equal(payload.productionCapabilitiesEnabled, false);
  assert.equal(payload.stablePromotionAuthorized, false);
  assert.deepEqual(payload, JSON.parse(fs.readFileSync(path.join(root, report), 'utf8')));
});

test('计划模式即使环境中存在全部凭据也不访问Blob或输出凭据', () => {
  const result = run([], executionEnv());
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.projectIdConfigured, true);
  assert.equal(payload.apiTokenConfigured, true);
  assert.equal(payload.executionUnlockConfigured, true);
  assert.equal(payload.realBlobReadsPerformed, 0);
  assert.equal(payload.realBlobWritesPerformed, 0);
  assert.equal(payload.realBlobDeletesPerformed, 0);
  assert.doesNotMatch(result.stdout, new RegExp(token, 'u'));
  assert.doesNotMatch(result.stdout, new RegExp(unlock, 'u'));
});

test('真实执行只接受GitHub手动事件、main和审批环境', () => {
  const wrongEvent = run(['--execute'], executionEnv({ GITHUB_EVENT_NAME: 'push' }));
  assert.notEqual(wrongEvent.status, 0);
  assert.match(wrongEvent.stderr, /BOOTSTRAP_EVENT_INVALID/u);

  const wrongBranch = run(['--execute'], executionEnv({ GITHUB_REF: 'refs/heads/feature' }));
  assert.notEqual(wrongBranch.status, 0);
  assert.match(wrongBranch.stderr, /BOOTSTRAP_BRANCH_INVALID/u);

  const wrongEnvironment = run(['--execute'], executionEnv({ BOOTSTRAP_APPROVAL_ENVIRONMENT: '' }));
  assert.notEqual(wrongEnvironment.status, 0);
  assert.match(wrongEnvironment.stderr, /BOOTSTRAP_APPROVAL_ENVIRONMENT_INVALID/u);
});

test('真实执行要求双文本确认和独立随机解锁值', () => {
  const wrongConfirmation = run(['--execute'], executionEnv({ CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: 'wrong' }));
  assert.notEqual(wrongConfirmation.status, 0);
  assert.match(wrongConfirmation.stderr, /BOOTSTRAP_CONFIRMATION_INVALID/u);

  const wrongImpact = run(['--execute'], executionEnv({ BOOTSTRAP_IMPACT_ACKNOWLEDGEMENT: 'wrong' }));
  assert.notEqual(wrongImpact.status, 0);
  assert.match(wrongImpact.stderr, /BOOTSTRAP_IMPACT_ACKNOWLEDGEMENT_INVALID/u);

  const missingUnlock = run(['--execute'], executionEnv({ EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK: '' }));
  assert.notEqual(missingUnlock.status, 0);
  assert.match(missingUnlock.stderr, /BOOTSTRAP_EXECUTION_LOCKED/u);

  const reusedUnlock = run(['--execute'], executionEnv({ EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK: token }));
  assert.notEqual(reusedUnlock.status, 0);
  assert.match(reusedUnlock.stderr, /BOOTSTRAP_EXECUTION_VALUE_REUSED/u);
  assert.doesNotMatch(reusedUnlock.stderr, new RegExp(token, 'u'));
});

test('初始化器使用官方外部SDK强一致参数且执行错误脱敏', () => {
  const source = fs.readFileSync(path.join(root, script), 'utf8');
  assert.match(source, /getStore\(\{ name: PUBLIC_STORE, projectId, token, consistency: 'strong' \}\)/u);
  assert.match(source, /getStore\(\{ name: ADMIN_STORE, projectId, token, consistency: 'strong' \}\)/u);
  assert.match(source, /executeProductionBootstrap/u);
  assert.match(source, /EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK/u);
  assert.match(source, /safeFailureMessage/u);
  assert.match(source, /核对项目ID、API Token权限、网络和平台状态/u);
  assert.match(source, /productionCapabilitiesEnabled:\s*false/u);
  assert.match(source, /stablePromotionAuthorized:\s*false/u);
  assert.doesNotMatch(source, /safeFailureMessage[\s\S]*return error\?\.message[^\n]*executeRequested/u);
  assert.doesNotMatch(source, /console\.log\([^\n]*token|JSON\.stringify\([^\n]*token/u);
});

test('手动工作流默认plan且真实执行要求main、环境审批和四重门禁', () => {
  const workflow = fs.readFileSync(path.join(root, workflowPath), 'utf8');
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /default:\s*plan/u);
  assert.match(workflow, /impact_acknowledgement:/u);
  assert.match(workflow, /WRITE-10-IMMUTABLE-OBJECTS/u);
  assert.match(workflow, /inputs\.operation == 'execute' && github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment:\s*production-bootstrap/u);
  assert.match(workflow, /secrets\.EDGEONE_PROJECT_ID/u);
  assert.match(workflow, /secrets\.EDGEONE_API_TOKEN/u);
  assert.match(workflow, /secrets\.EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK/u);
  assert.match(workflow, /timeout-minutes:\s*10/u);
  assert.match(workflow, /cancel-in-progress:\s*false/u);
  assert.match(workflow, /needs:\s*plan/u);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule):/mu);
});
