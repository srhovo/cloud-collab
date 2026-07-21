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
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-collab-stage8d-'));
  const project = path.join(temporary, 'deploy', 'admin');
  fs.mkdirSync(project, { recursive: true });
  try { return run(project); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

test('管理员子项目生成四文件产物并显示初始无会话状态', () => temporaryProject(project => {
  const result = prepareAdminDeploymentRoot({
    repositoryRoot: root,
    projectRoot: project,
    commitSha: 'a'.repeat(40),
  });
  const output = path.join(project, ADMIN_STATIC_OUTPUT);
  assert.deepEqual(result.files, [...ADMIN_STATIC_FILES].sort());
  assert.deepEqual(fs.readdirSync(output).sort(), [...ADMIN_STATIC_FILES].sort());
  const script = fs.readFileSync(path.join(output, 'production-console.js'), 'utf8');
  assert.equal(script.includes(ADMIN_SESSION_RENDERED), true);
  assert.equal(script.includes(ADMIN_SESSION_TEMPLATE), false);
  const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  assert.match(html, /\.\/production-console\.css/u);
  assert.match(html, /\.\/production-console\.js/u);
  const release = JSON.parse(fs.readFileSync(path.join(output, 'admin-release.json'), 'utf8'));
  assert.equal(release.kind, 'production_admin_console_deployment');
  assert.equal(release.sourceCommit, 'a'.repeat(40));
  assert.equal(release.projectRoot, ADMIN_DEPLOYMENT_ROOT);
  assert.equal(release.outputDirectory, ADMIN_STATIC_OUTPUT);
  assert.equal(release.contentFiles.length, 3);
  assert.equal(release.anonymousPublicApiIncluded, false);
  assert.equal(release.initialSessionProbeVisible, true);
  assert.equal(release.includesOrdinaryUserCandidate, false);
  assert.equal(release.includesSecretValues, false);
  assert.equal(release.stableVersion, '8.2.25');
  assert.equal(release.candidateVersion, '8.2.31');
  assert.equal(release.stablePromotionAuthorized, false);
  assert.equal(release.stablePromotionPerformed, false);
  assert.equal(release.productionWriteEnablementIncluded, false);
  for (const descriptor of release.contentFiles) {
    assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(descriptor.bytes, fs.statSync(path.join(output, descriptor.filename)).size);
  }
}));

test('管理员子项目只复制管理员API并完成相对导入审计', () => temporaryProject(project => {
  const result = prepareAdminDeploymentRoot({
    repositoryRoot: root,
    projectRoot: project,
    commitSha: 'b'.repeat(40),
  });
  const apiFiles = walk(path.join(project, 'cloud-functions', 'api'));
  assert.equal(apiFiles.length > 10, true);
  assert.equal(apiFiles.every(filename => filename.startsWith('admin/')), true);
  assert.equal(apiFiles.includes('device/register.js'), false);
  assert.equal(apiFiles.includes('submissions/create.js'), false);
  assert.equal(apiFiles.includes('sensitive-submissions/create.js'), false);
  assert.equal(result.release.runtimeAudit.cloudFunctionFileCount > apiFiles.length, true);
  assert.equal(result.release.runtimeAudit.serverFileCount > 20, true);
  assert.equal(fs.existsSync(path.join(project, 'cloud-functions', '_shared', 'runtime_env.js')), true);
  assert.equal(fs.existsSync(path.join(project, 'src', 'server', 'production_admin_auth_v1.js')), true);
}));

test('普通用户与管理员静态文件范围严格互斥', () => {
  assert.deepEqual(PUBLIC_CANDIDATE_FILES, ['index.html', 'build-manifest.json', 'pages-release.json']);
  assert.deepEqual(ADMIN_STATIC_FILES, ['index.html', 'production-console.css', 'production-console.js', 'admin-release.json']);
  assert.equal(PUBLIC_CANDIDATE_FILES.includes('admin-release.json'), false);
  assert.equal(ADMIN_STATIC_FILES.includes('build-manifest.json'), false);
  assert.equal(ADMIN_STATIC_FILES.includes('pages-release.json'), false);
});

test('管理员构建器拒绝缺失根目录与无效提交', () => {
  assert.throws(
    () => prepareAdminDeploymentRoot({
      repositoryRoot: root,
      projectRoot: path.join(root, 'missing-stage8d-root'),
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
