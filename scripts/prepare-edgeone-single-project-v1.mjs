import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLIC_CANDIDATE_FILES, preparePublicCandidate } from './prepare-public-candidate-v1.mjs';
import {
  ADMIN_CONSOLE_FILES,
  ADMIN_CONSOLE_OUTPUT_DIRECTORY,
  prepareAdminConsole,
} from './prepare-admin-console-v1.mjs';

export const EDGEONE_SINGLE_PROJECT_OUTPUT = '.edgeone-artifact';
export const EDGEONE_ADMIN_INTERNAL_DIRECTORY = '__admin';

export class EdgeOneSingleProjectArtifactError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'EdgeOneSingleProjectArtifactError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new EdgeOneSingleProjectArtifactError(code, message, details);
};

function safeOutputDirectory(root, outputDirectory) {
  const repositoryRoot = path.resolve(root);
  const target = path.resolve(outputDirectory || path.join(repositoryRoot, EDGEONE_SINGLE_PROJECT_OUTPUT));
  if (path.relative(repositoryRoot, target) !== EDGEONE_SINGLE_PROJECT_OUTPUT) {
    fail('EDGEONE_SINGLE_PROJECT_OUTPUT_UNSAFE', '单项目产物只能输出到.edgeone-artifact');
  }
  return target;
}

function assertPlainTree(directory) {
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('EDGEONE_SINGLE_PROJECT_SYMLINK_FORBIDDEN', '产物不得包含符号链接', { absolute });
      if (stat.isDirectory()) pending.push(absolute);
      else if (!stat.isFile()) fail('EDGEONE_SINGLE_PROJECT_FILE_TYPE_INVALID', '产物只能包含普通文件和目录', { absolute });
    }
  }
}

export function prepareEdgeOneSingleProject({ root, outputDirectory, commitSha } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const target = safeOutputDirectory(repositoryRoot, outputDirectory);
  const adminTemporary = path.join(repositoryRoot, ADMIN_CONSOLE_OUTPUT_DIRECTORY);

  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(adminTemporary, { recursive: true, force: true });

  try {
    const publicResult = preparePublicCandidate({
      root: repositoryRoot,
      outputDirectory: target,
      commitSha,
      channel: 'edgeone-primary',
    });
    const adminResult = prepareAdminConsole({
      root: repositoryRoot,
      outputDirectory: adminTemporary,
      commitSha,
    });

    const adminTarget = path.join(target, EDGEONE_ADMIN_INTERNAL_DIRECTORY);
    fs.mkdirSync(adminTarget, { recursive: false });
    for (const filename of ADMIN_CONSOLE_FILES) {
      fs.copyFileSync(path.join(adminTemporary, filename), path.join(adminTarget, filename));
    }

    const topLevel = fs.readdirSync(target).sort();
    const expectedTopLevel = [...PUBLIC_CANDIDATE_FILES, EDGEONE_ADMIN_INTERNAL_DIRECTORY].sort();
    if (JSON.stringify(topLevel) !== JSON.stringify(expectedTopLevel)) {
      fail('EDGEONE_SINGLE_PROJECT_TOP_LEVEL_INVALID', '单项目顶层产物范围无效', { topLevel });
    }
    const administratorFiles = fs.readdirSync(adminTarget).sort();
    if (JSON.stringify(administratorFiles) !== JSON.stringify([...ADMIN_CONSOLE_FILES].sort())) {
      fail('EDGEONE_SINGLE_PROJECT_ADMIN_SCOPE_INVALID', '单项目管理员内部产物范围无效', { administratorFiles });
    }

    for (const filename of ADMIN_CONSOLE_FILES) {
      if (fs.existsSync(path.join(target, filename)) && !PUBLIC_CANDIDATE_FILES.includes(filename)) {
        fail('EDGEONE_SINGLE_PROJECT_ADMIN_ROOT_LEAK', '管理员文件不得出现在公开根目录', { filename });
      }
    }
    if (fs.existsSync(path.join(adminTarget, 'build-manifest.json'))
        || fs.existsSync(path.join(adminTarget, 'pages-release.json'))) {
      fail('EDGEONE_SINGLE_PROJECT_PUBLIC_ADMIN_LEAK', '普通用户发布文件不得进入管理员内部目录');
    }

    assertPlainTree(target);

    return Object.freeze({
      schemaVersion: 1,
      stage: '8J',
      topology: 'single_edgeone_project_two_custom_domains',
      outputDirectory: target,
      publicHostname: 'app.xiaxue.site',
      administratorHostname: 'admin.xiaxue.site',
      publicFiles: Object.freeze([...publicResult.files]),
      administratorInternalDirectory: EDGEONE_ADMIN_INTERNAL_DIRECTORY,
      administratorFiles: Object.freeze([...adminResult.files]),
      accountApiTokenRequiredAtRuntime: false,
      productionCapabilitiesEnabled: false,
      stablePromotionAuthorized: false,
    });
  } finally {
    fs.rmSync(adminTemporary, { recursive: true, force: true });
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = prepareEdgeOneSingleProject({
    root,
    outputDirectory: argumentValue('--output'),
    commitSha: argumentValue('--commit'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
