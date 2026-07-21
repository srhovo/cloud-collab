import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditStage8EAdminRootNoDeployment } from '../scripts/audit-stage8e-admin-root-no-deploy-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  '.github/workflows/stage8e-admin-deployment-root.yml',
  'scripts/prepare-admin-deployment-root-v1.mjs',
  'scripts/audit-admin-deployment-runtime-v1.mjs',
  'deploy/admin/edgeone.json',
  'package.json',
];

function fixtureRoot() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-collab-stage8e-root-audit-'));
  for (const relative of targets) {
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  return target;
}

test('管理员部署根工作流只读、无部署命令且无真实网络目标', () => {
  const result = auditStage8EAdminRootNoDeployment({ root });
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

test('管理员部署根审计拒绝部署命令、写权限和真实网络目标', () => {
  const target = fixtureRoot();
  try {
    const packagePath = path.join(target, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    pkg.scripts.unsafe = 'wrangler deploy';
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    assert.throws(
      () => auditStage8EAdminRootNoDeployment({ root: target }),
      error => error.code === 'STAGE8E_ADMIN_ROOT_DEPLOY_FORBIDDEN',
    );

    fs.copyFileSync(path.join(root, 'package.json'), packagePath);
    const workflowPath = path.join(target, '.github/workflows/stage8e-admin-deployment-root.yml');
    const original = fs.readFileSync(workflowPath, 'utf8');
    fs.writeFileSync(workflowPath, original.replace('contents: read', 'contents: write'), 'utf8');
    assert.throws(
      () => auditStage8EAdminRootNoDeployment({ root: target }),
      error => error.code === 'STAGE8E_ADMIN_ROOT_DEPLOY_FORBIDDEN',
    );

    fs.writeFileSync(workflowPath, `${original}\n# real network marker: https colon slash slash example.invalid\n`, 'utf8');
    assert.throws(
      () => auditStage8EAdminRootNoDeployment({ root: target }),
      error => error.code === 'STAGE8E_ADMIN_ROOT_NETWORK_TARGET_FORBIDDEN',
    );
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
