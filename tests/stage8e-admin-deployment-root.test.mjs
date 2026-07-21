import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PUBLIC_CANDIDATE_FILES } from '../scripts/prepare-public-candidate-v1.mjs';
import {
  ADMIN_DEPLOYMENT_ROOT,
  ADMIN_SESSION_RENDERED,
  ADMIN_SESSION_TEMPLATE,
  ADMIN_STATIC_FILES,
  ADMIN_STATIC_OUTPUT,
  prepareAdminDeploymentRoot,
} from '../scripts/prepare-admin-deployment-root-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(directory) {
  const result = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) result.push(path.relative(directory, target).split(path.sep).join('/'));
      else throw new Error(`unexpected file type: ${target}`);
    }
  };
  visit(directory);
  return result.sort();
}

function temporaryProject(run) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-collab-stage8e-root-'));
  const project = path.join(temporary, 'deploy', 'admin');
  fs.mkdirSync(project, { recursive: true });
  try { return run(project); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

test('管理员部署根生成四文件、可见会话探测和冻结身份清单', () => temporaryProject(project => {
  const result = prepareAdminDeploymentRoot({ repositoryRoot: root, projectRoot: project, commitSha: 'a'.repeat(40) });
  const output = path.join(project, ADMIN_STATIC_OUTPUT);
  assert.deepEqual(result.files, [...ADMIN_STATIC_FILES].sort());
  assert.deepEqual(fs.readdirSync(output).sort(), [...ADMIN_STATIC_FILES].sort());
  const script = fs.readFileSync(path.join(output, 'production-console.js'), 'utf8');
  assert.equal(script.includes(ADMIN_SESSION_RENDERED), true);
  assert.equal(script.includes(ADMIN_SESSION_TEMPLATE), false);
  const release = JSON.parse(fs.readFileSync(path.join(output, 'admin-release.json'), 'utf8'));
  assert.equal(release.kind, 'production_admin_console_deployment');
  assert.equal(release.deploymentStatus, 'code_complete_not_deployed');
  assert.equal(release.sourceCommit, 'a'.repeat(40));
  assert.equal(release.title, '码单器正式管理员控制台');
  assert.equal(release.projectRoot, ADMIN_DEPLOYMENT_ROOT);
  assert.equal(release.projectConfig, 'deploy/admin/edgeone.json');
  assert.equal(release.outputDirectory, ADMIN_STATIC_OUTPUT);
  assert.deepEqual(release.outputFiles, ADMIN_STATIC_FILES);
  assert.equal(release.contentFiles.find(item => item.filename === 'production-console.js').contentType, 'application/javascript; charset=utf-8');
  assert.equal(release.anonymousPublicApiIncluded, false);
  assert.equal(release.intendedOriginEnv, 'CLOUD_ADMIN_PUBLIC_ORIGIN');
  assert.equal(release.platformResponseHeadersRequired, true);
  assert.equal(release.initialSessionProbeVisible, true);
  assert.equal(release.includesOrdinaryUserCandidate, false);
  assert.equal(release.includesSecretValues, false);
  assert.equal(release.productionCapabilitiesDefaultOff, true);
  assert.deepEqual(release.frozenPublicCandidate, {
    version: '8.2.31',
    sha256: '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b',
  });
  assert.equal(release.stableVersion, '8.2.25');
  assert.equal(release.stablePromotionAuthorized, false);
  assert.equal(release.stablePromotionPerformed, false);
  assert.equal(release.productionWriteEnablementIncluded, false);
  assert.equal(release.runtimeAudit.totalRuntimeBytes > 0, true);
  assert.equal(release.runtimeAudit.totalRuntimeBytes < 32 * 1024 * 1024, true);
  for (const descriptor of release.contentFiles) {
    assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(descriptor.bytes, fs.statSync(path.join(output, descriptor.filename)).size);
  }
}));

test('管理员部署根只复制管理员API并完成相对导入闭包审计', () => temporaryProject(project => {
  const result = prepareAdminDeploymentRoot({ repositoryRoot: root, projectRoot: project, commitSha: 'b'.repeat(40) });
  const apiFiles = walk(path.join(project, 'cloud-functions', 'api'));
  assert.equal(apiFiles.length > 10, true);
  assert.equal(apiFiles.every(filename => filename.startsWith('admin/')), true);
  assert.equal(apiFiles.includes('device/register.js'), false);
  assert.equal(apiFiles.includes('submissions/create.js'), false);
  assert.equal(apiFiles.includes('sensitive-submissions/create.js'), false);
  assert.equal(result.release.runtimeAudit.administratorApiFileCount, apiFiles.length);
  assert.equal(result.release.runtimeAudit.cloudFunctionFileCount > apiFiles.length, true);
  assert.equal(result.release.runtimeAudit.serverFileCount > 20, true);
  assert.equal(fs.existsSync(path.join(project, 'cloud-functions', '_shared', 'runtime_env.js')), true);
  assert.equal(fs.existsSync(path.join(project, 'src', 'server', 'production_admin_auth_v1.js')), true);
}));

test('管理员部署静态范围与普通候选三文件严格互斥', () => {
  assert.deepEqual(PUBLIC_CANDIDATE_FILES, ['index.html', 'build-manifest.json', 'pages-release.json']);
  assert.deepEqual(ADMIN_STATIC_FILES, ['index.html', 'production-console.css', 'production-console.js', 'admin-release.json']);
  assert.equal(PUBLIC_CANDIDATE_FILES.includes('admin-release.json'), false);
  assert.equal(ADMIN_STATIC_FILES.includes('build-manifest.json'), false);
  assert.equal(ADMIN_STATIC_FILES.includes('pages-release.json'), false);
});

test('管理员部署根拒绝缺失目录和无效提交', () => {
  assert.throws(
    () => prepareAdminDeploymentRoot({
      repositoryRoot: root,
      projectRoot: path.join(root, 'missing-stage8e-admin-root'),
      commitSha: 'c'.repeat(40),
    }),
    error => error.code === 'ADMIN_DEPLOYMENT_PROJECT_ROOT_MISSING',
  );
  temporaryProject(project => {
    assert.throws(
      () => prepareAdminDeploymentRoot({ repositoryRoot: root, projectRoot: project, commitSha: 'short' }),
      error => error.code === 'ADMIN_DEPLOYMENT_COMMIT_INVALID',
    );
  });
});
