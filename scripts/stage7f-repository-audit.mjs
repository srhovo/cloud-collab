import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditReleaseRepository } from './release-readiness-audit-v1.mjs';
import { PUBLIC_ARTIFACT_FILES } from './prepare-pages-artifact.mjs';

export class Stage7FRepositoryAuditError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'Stage7FRepositoryAuditError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new Stage7FRepositoryAuditError(code, message, details);
};
const read = (root, relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function assertIncludes(text, needles, code, label) {
  const missing = needles.filter(needle => !text.includes(needle));
  if (missing.length) fail(code, `${label}缺少发布门禁`, { missing });
}

function trackedFiles(root) {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function secretSignatureFindings(root) {
  const signatures = [
    ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
    ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/g],
  ];
  const findings = [];
  for (const relativePath of trackedFiles(root)) {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    const bytes = fs.readFileSync(absolutePath);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const [kind, pattern] of signatures) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) findings.push({ relativePath, kind });
    }
  }
  return findings;
}

function externalRuntimeDependencies(html) {
  const matches = html.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
  const urls = [...new Set(matches.map(value => value.replace(/[),.;]+$/, '')))];
  const nonNetworkLiterals = new Set([
    'http://www.w3.org/2000/svg',
    'https://local.invalid',
    'https://local.invalid/',
  ]);
  return urls.filter(value => !nonNetworkLiterals.has(value)).sort();
}

export function auditStage7FRepository({ root } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const release = auditReleaseRepository({ root: repositoryRoot });
  const packageJson = JSON.parse(read(repositoryRoot, 'package.json'));
  const pagesWorkflow = read(repositoryRoot, '.github/workflows/pages.yml');
  const ciWorkflow = read(repositoryRoot, '.github/workflows/ci.yml');
  const edgeOneConfig = JSON.parse(read(repositoryRoot, 'edgeone.json'));
  const readme = read(repositoryRoot, 'README.md');
  const deploymentGuide = read(repositoryRoot, 'docs/GitHub与EdgeOne部署清单.md');
  const coreCompare = read(repositoryRoot, 'tests/core_compare.py');
  const browserIntegration = read(repositoryRoot, 'tests/browser_integration.py');
  const html = read(repositoryRoot, 'dist/index.html');

  if (/\n\s{2}push\s*:/.test(pagesWorkflow)) {
    fail('STAGE7F_PAGES_AUTO_PUSH', 'GitHub Pages仍由push自动发布');
  }
  assertIncludes(pagesWorkflow, [
    'workflow_dispatch:',
    'npm ci --ignore-scripts',
    'npm run ci',
    'npm run pages:prepare',
    'path: ./.pages-artifact',
    'npm run pages:verify',
  ], 'STAGE7F_PAGES_GATE_INCOMPLETE', 'GitHub Pages工作流');
  assertIncludes(ciWorkflow, [
    'push:',
    'pull_request:',
    'npm ci --ignore-scripts',
    'npm run ci',
  ], 'STAGE7F_CI_GATE_INCOMPLETE', 'CI工作流');
  if (edgeOneConfig.installCommand !== 'npm ci --ignore-scripts'
      || edgeOneConfig.buildCommand !== 'npm run edgeone:build'
      || edgeOneConfig.outputDirectory !== './.edgeone-artifact') {
    fail('STAGE7F_EDGEONE_ARTIFACT_SCOPE_INVALID', 'EdgeOne未使用锁定安装与最小公开产物');
  }
  if (packageJson.scripts?.['edgeone:build']
        !== 'npm run ci && npm run pages:prepare -- --channel edgeone-primary --output .edgeone-artifact'
      || packageJson.scripts?.['pages:prepare'] !== 'node scripts/prepare-pages-artifact.mjs'
      || packageJson.scripts?.['pages:verify'] !== 'node scripts/verify-pages-deployment.mjs'
      || !String(packageJson.scripts?.ci || '').includes('npm run audit:dependencies')) {
    fail('STAGE7F_PACKAGE_GATE_INCOMPLETE', 'package.json发布或依赖门禁无效');
  }
  assertIncludes(coreCompare, ['--html', '--expected-version'], 'STAGE7F_TEST_TARGET_INCOMPLETE', '核心对比测试');
  assertIncludes(browserIntegration, ['--html', '--expected-version'], 'STAGE7F_TEST_TARGET_INCOMPLETE', '浏览器集成测试');
  assertIncludes(readme, ['阶段7F', '8.2.30', '正式公共写入保持关闭'], 'STAGE7F_README_STALE', 'README');
  assertIncludes(deploymentGuide, ['阶段7F', 'GitHub Pages', 'EdgeOne'], 'STAGE7F_DEPLOYMENT_DOC_STALE', '部署清单');

  const secretFindings = secretSignatureFindings(repositoryRoot);
  if (secretFindings.length) fail('STAGE7F_SECRET_SIGNATURE_FOUND', '跟踪文件命中常见私密值特征', { findings: secretFindings });

  const dependencies = externalRuntimeDependencies(html);
  const allowedDependencies = ['https://cdn.jsdelivr.net/gh/srhovo/tutorialvideo@main/video.mp4'];
  const unexpected = dependencies.filter(value => !allowedDependencies.includes(value));
  if (unexpected.length) fail('STAGE7F_EXTERNAL_DEPENDENCY_UNEXPECTED', '候选HTML包含未登记的外部运行依赖', { unexpected });

  const distFiles = fs.readdirSync(path.join(repositoryRoot, 'dist')).sort();
  const excludedPreviewPages = distFiles.filter(filename => /^admin-.*-preview\.html$|^admin-preview\.html$/.test(filename));
  if (excludedPreviewPages.length !== 8) {
    fail('STAGE7F_PREVIEW_INVENTORY_CHANGED', '管理员预览页清单数量发生变化', { excludedPreviewPages });
  }

  return Object.freeze({
    schemaVersion: 1,
    stage: '7F-release-consistency',
    status: release.blockers.length ? 'passed_with_release_blockers' : 'passed_release_ready_for_separate_authorization',
    candidate: release.candidate,
    checks: Object.freeze({
      ciBuildAndRegressionRequired: true,
      pagesManualDispatchOnly: true,
      pagesMinimalArtifactAllowlist: PUBLIC_ARTIFACT_FILES,
      edgeOneMinimalArtifactAllowlist: PUBLIC_ARTIFACT_FILES,
      postDeploymentHashVerificationRequired: true,
      genericBrowserTargetsExplicit: true,
      commonSecretSignatureScanPassed: true,
      productionWriteDefaultsOff: release.environment.allEnabledGatesDefaultOff,
    }),
    inventory: Object.freeze({
      excludedPreviewPages: Object.freeze(excludedPreviewPages),
      externalRuntimeDependencies: Object.freeze(dependencies),
    }),
    remainingReleaseBlockers: release.blockers,
    boundaries: Object.freeze({
      stableBaselineModified: false,
      localStorageOrBackupSchemaModified: false,
      productionWriteEnablementIncluded: false,
      deploymentPerformed: false,
    }),
  });
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = auditStage7FRepository({ root });
  fs.writeFileSync(path.join(root, 'dist', 'stage7f-repository-audit.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
