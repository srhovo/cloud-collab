import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class Stage8DNoDeployAuditError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'Stage8DNoDeployAuditError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new Stage8DNoDeployAuditError(code, message, details);
};

const TARGETS = Object.freeze([
  '.github/workflows/stage8d-admin-artifact-isolation.yml',
  'scripts/prepare-admin-console-v1.mjs',
  'scripts/verify-admin-public-artifact-isolation-v1.mjs',
  'package.json',
]);

const FORBIDDEN = Object.freeze([
  /\bwrangler\s+deploy\b/iu,
  /\bedgeone(?:\s+[^\s]+)*\s+deploy\b/iu,
  /\bcurl\b[^\n]*(?:\/deploy|deployments)/iu,
  /\bnpx\b[^\n]*\bdeploy\b/iu,
  /\bdeployments\s*:\s*write\b/iu,
  /\bid-token\s*:\s*write\b/iu,
  /\bcontents\s*:\s*write\b/iu,
]);

const ALLOWED_ACTIONS = new Set([
  'actions/checkout@v4',
  'actions/setup-node@v4',
  'actions/upload-artifact@v4',
]);

export function auditStage8DNoDeployment({ root } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const sources = TARGETS.map(relativePath => Object.freeze({
    relativePath,
    text: fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'),
  }));

  for (const { relativePath, text } of sources) {
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) {
        fail('STAGE8D_DEPLOY_COMMAND_FORBIDDEN', '阶段8D包含部署或写权限指令', {
          relativePath,
          pattern: pattern.source,
        });
      }
    }
  }

  const workflow = sources.find(item => item.relativePath.startsWith('.github/workflows/'))?.text || '';
  const actionMatches = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gmu)].map(match => match[1]);
  if (!actionMatches.length) fail('STAGE8D_ACTIONS_MISSING', '阶段8D工作流缺少Actions步骤');
  const disallowedActions = actionMatches.filter(action => !ALLOWED_ACTIONS.has(action));
  if (disallowedActions.length) {
    fail('STAGE8D_ACTION_NOT_ALLOWED', '阶段8D工作流引用了未授权Action', { disallowedActions });
  }
  if (!workflow.includes('permissions:\n  contents: read')) {
    fail('STAGE8D_PERMISSIONS_INVALID', '阶段8D工作流必须保持只读仓库权限');
  }

  return Object.freeze({
    verified: true,
    scannedFiles: Object.freeze(TARGETS),
    actions: Object.freeze(actionMatches),
    repositoryPermission: 'contents:read',
    deploymentCommandPresent: false,
    deploymentPerformed: false,
  });
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.stdout.write(`${JSON.stringify(auditStage8DNoDeployment({ root }))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
