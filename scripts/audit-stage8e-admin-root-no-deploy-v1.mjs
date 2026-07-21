import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class Stage8EAdminRootAuditError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'Stage8EAdminRootAuditError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new Stage8EAdminRootAuditError(code, message, details);
};
const TARGETS = Object.freeze([
  '.github/workflows/stage8e-admin-deployment-root.yml',
  'scripts/prepare-admin-deployment-root-v1.mjs',
  'scripts/audit-admin-deployment-runtime-v1.mjs',
  'deploy/admin/edgeone.json',
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

export function auditStage8EAdminRootNoDeployment({ root } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const sources = TARGETS.map(relativePath => Object.freeze({
    relativePath,
    text: fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'),
  }));
  for (const { relativePath, text } of sources) {
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) {
        fail('STAGE8E_ADMIN_ROOT_DEPLOY_FORBIDDEN', '阶段8E管理员部署根包含部署或写权限指令', {
          relativePath,
          pattern: pattern.source,
        });
      }
    }
  }
  const workflow = sources.find(item => item.relativePath.startsWith('.github/workflows/'))?.text || '';
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gmu)].map(match => match[1]);
  if (!actions.length) fail('STAGE8E_ADMIN_ROOT_ACTIONS_MISSING', '专项工作流缺少Actions步骤');
  const disallowed = actions.filter(action => !ALLOWED_ACTIONS.has(action));
  if (disallowed.length) fail('STAGE8E_ADMIN_ROOT_ACTION_NOT_ALLOWED', '专项工作流引用未授权Action', { disallowed });
  if (!workflow.includes('permissions:\n  contents: read')) {
    fail('STAGE8E_ADMIN_ROOT_PERMISSIONS_INVALID', '专项工作流必须保持只读仓库权限');
  }
  if (/\bhttps?:\/\//iu.test(workflow)) {
    fail('STAGE8E_ADMIN_ROOT_NETWORK_TARGET_FORBIDDEN', '专项工作流不得包含真实网络目标');
  }
  return Object.freeze({
    verified: true,
    scannedFiles: TARGETS,
    actions: Object.freeze(actions),
    repositoryPermission: 'contents:read',
    realNetworkRequestPerformed: false,
    deploymentPerformed: false,
  });
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.stdout.write(`${JSON.stringify(auditStage8EAdminRootNoDeployment({ root }))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
