import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditStage8ENoDeployment } from '../scripts/audit-stage8e-verifier-no-deploy-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  '.github/workflows/stage8e-admin-deployment-verification.yml',
  'scripts/verify-admin-deployment-v1.mjs',
  'package.json',
];

function fixtureRoot() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-collab-stage8e-audit-'));
  for (const relative of targets) {
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  return target;
}

test('阶段8E工作流只运行模拟验证、只读Actions且不访问真实来源', () => {
  const result = auditStage8ENoDeployment({ root });
  assert.equal(result.verified, true);
  assert.equal(result.repositoryPermission, 'contents:read');
  assert.equal(result.realNetworkRequestPerformed, false);
  assert.equal(result.deploymentPerformed, false);
  assert.deepEqual([...new Set(result.actions)].sort(), [
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'actions/upload-artifact@v4',
  ]);
});

test('阶段8E审计拒绝部署命令、写权限和真实网络目标', () => {
  const target = fixtureRoot();
  try {
    const packagePath = path.join(target, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    pkg.scripts.unsafe = 'npx vendor deploy';
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    assert.throws(
      () => auditStage8ENoDeployment({ root: target }),
      error => error.code === 'STAGE8E_DEPLOY_COMMAND_FORBIDDEN',
    );

    fs.copyFileSync(path.join(root, 'package.json'), packagePath);
    const workflowPath = path.join(target, '.github/workflows/stage8e-admin-deployment-verification.yml');
    const original = fs.readFileSync(workflowPath, 'utf8');
    fs.writeFileSync(workflowPath, original.replace('contents: read', 'contents: write'), 'utf8');
    assert.throws(
      () => auditStage8ENoDeployment({ root: target }),
      error => error.code === 'STAGE8E_DEPLOY_COMMAND_FORBIDDEN',
    );

    fs.writeFileSync(workflowPath, `${original}\n# https://admin.real.example\n`, 'utf8');
    assert.throws(
      () => auditStage8ENoDeployment({ root: target }),
      error => error.code === 'STAGE8E_REAL_NETWORK_TARGET_FORBIDDEN',
    );
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
