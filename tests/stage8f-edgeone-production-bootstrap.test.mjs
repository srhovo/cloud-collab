import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = 'scripts/run-edgeone-production-bootstrap-v1.mjs';
const workflowPath = '.github/workflows/stage8f-edgeone-production-bootstrap.yml';

function run(args = [], env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('默认模式只生成10项零写入初始化计划', () => {
  const report = 'dist/stage8f-test-bootstrap-plan.json';
  fs.rmSync(path.join(root, report), { force: true });
  const result = run([], { BOOTSTRAP_REPORT_PATH: report });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stage, '8F');
  assert.equal(payload.operation, 'plan');
  assert.equal(payload.status, 'ready_not_executed');
  assert.equal(payload.projectIdConfigured, false);
  assert.equal(payload.apiTokenConfigured, false);
  assert.equal(payload.publicStoreName, 'cloud-collab-production-v1');
  assert.equal(payload.adminStoreName, 'cloud-collab-admin-production-v1');
  assert.equal(payload.resourceCount, 10);
  assert.equal(payload.resources.length, 10);
  assert.equal(payload.confirmationRequired, 'INITIALIZE-see-see_cz-V1');
  assert.equal(payload.namespaceCreation, 'automatic_on_first_sdk_getStore_call');
  assert.equal(payload.blobConsoleAccess, 'read_only_browse');
  assert.equal(payload.realSecretValuesExposed, false);
  assert.equal(payload.realBlobReadsPerformed, 0);
  assert.equal(payload.realBlobWritesPerformed, 0);
  assert.equal(payload.realBlobDeletesPerformed, 0);
  assert.equal(payload.productionCapabilitiesEnabled, false);
  assert.equal(payload.stablePromotionAuthorized, false);

  assert.deepEqual(payload, JSON.parse(fs.readFileSync(path.join(root, report), 'utf8')));
});

test('计划模式即使环境中存在凭据也不访问Blob或输出凭据', () => {
  const token = `secret-token-${'x'.repeat(40)}`;
  const result = run([], {
    EDGEONE_PROJECT_ID: 'pages-urtsvuwmfvli',
    EDGEONE_API_TOKEN: token,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.projectIdConfigured, true);
  assert.equal(payload.apiTokenConfigured, true);
  assert.equal(payload.realBlobReadsPerformed, 0);
  assert.equal(payload.realBlobWritesPerformed, 0);
  assert.equal(payload.realBlobDeletesPerformed, 0);
  assert.doesNotMatch(result.stdout, new RegExp(token, 'u'));
});

test('真实执行缺少项目ID时在创建Store前失败', () => {
  const result = run(['--execute'], {
    EDGEONE_PROJECT_ID: '',
    EDGEONE_API_TOKEN: `secret-token-${'x'.repeat(40)}`,
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: 'INITIALIZE-see-see_cz-V1',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EDGEONE_PROJECT_ID_INVALID/u);
  assert.equal(result.stdout, '');
});

test('真实执行缺少Token或确认词时失败关闭', () => {
  const missingToken = run(['--execute'], {
    EDGEONE_PROJECT_ID: 'pages-urtsvuwmfvli',
    EDGEONE_API_TOKEN: '',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: 'INITIALIZE-see-see_cz-V1',
  });
  assert.notEqual(missingToken.status, 0);
  assert.match(missingToken.stderr, /EDGEONE_API_TOKEN_INVALID/u);

  const wrongConfirmation = run(['--execute'], {
    EDGEONE_PROJECT_ID: 'pages-urtsvuwmfvli',
    EDGEONE_API_TOKEN: `secret-token-${'x'.repeat(40)}`,
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: 'wrong',
  });
  assert.notEqual(wrongConfirmation.status, 0);
  assert.match(wrongConfirmation.stderr, /BOOTSTRAP_CONFIRMATION_INVALID/u);
});

test('初始化器使用官方外部SDK参数和强一致模式', () => {
  const source = fs.readFileSync(path.join(root, script), 'utf8');
  assert.match(source, /getStore\(\{ name: PUBLIC_STORE, projectId, token, consistency: 'strong' \}\)/u);
  assert.match(source, /getStore\(\{ name: ADMIN_STORE, projectId, token, consistency: 'strong' \}\)/u);
  assert.match(source, /executeProductionBootstrap/u);
  assert.match(source, /productionCapabilitiesEnabled:\s*false/u);
  assert.match(source, /stablePromotionAuthorized:\s*false/u);
  assert.doesNotMatch(source, /console\.log\([^\n]*token|JSON\.stringify\([^\n]*token/u);
});

test('手动工作流默认plan且真实执行要求四重门禁', () => {
  const workflow = fs.readFileSync(path.join(root, workflowPath), 'utf8');
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /default:\s*plan/u);
  assert.match(workflow, /inputs\.operation == 'execute'/u);
  assert.match(workflow, /INITIALIZE-see-see_cz-V1/u);
  assert.match(workflow, /secrets\.EDGEONE_PROJECT_ID/u);
  assert.match(workflow, /secrets\.EDGEONE_API_TOKEN/u);
  assert.match(workflow, /needs:\s*plan/u);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request):/mu);
});
