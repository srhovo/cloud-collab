import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditStage8DNoDeployment } from '../scripts/audit-stage8d-no-deploy-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  '.github/workflows/stage8d-admin-artifact-isolation.yml',
  'scripts/prepare-admin-console-v1.mjs',
  'scripts/verify-admin-public-artifact-isolation-v1.mjs',
  'package.json',
];

function fixtureRoot() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-collab-stage8d-audit-'));
  for (const relative of targets) {
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  return target;
}

test('阶段8D工作流仅使用允许的Actions和只读权限且不含部署命令', () => {
  const result = auditStage8DNoDeployment({ root });
  assert.equal(result.verified, true);
  assert.equal(result.repositoryPermission, 'contents:read');
  assert.equal(result.deploymentCommandPresent, false);
  assert.equal(result.deploymentPerformed, false);
  assert.deepEqual([...new Set(result.actions)].sort(), [
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'actions/upload-artifact@v4',
  ]);
});

test('阶段8D审计拒绝部署命令和仓库写权限', () => {
  const target = fixtureRoot();
  try {
    const packagePath = path.join(target, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    pkg.scripts.unsafe = 'wrangler deploy';
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    assert.throws(
      () => auditStage8DNoDeployment({ root: target }),
      error => error.code === 'STAGE8D_DEPLOY_COMMAND_FORBIDDEN',
    );

    fs.copyFileSync(path.join(root, 'package.json'), packagePath);
    const workflowPath = path.join(target, '.github/workflows/stage8d-admin-artifact-isolation.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8').replace('contents: read', 'contents: write');
    fs.writeFileSync(workflowPath, workflow, 'utf8');
    assert.throws(
      () => auditStage8DNoDeployment({ root: target }),
      error => error.code === 'STAGE8D_DEPLOY_COMMAND_FORBIDDEN',
    );
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
