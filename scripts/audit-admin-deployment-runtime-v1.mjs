import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export class AdminRuntimeAuditError extends Error {
  constructor(code, message, details = null, cause = null) {
    super(message || code);
    this.name = 'AdminRuntimeAuditError';
    this.code = code;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function fail(code, message, details = null, cause = null) {
  throw new AdminRuntimeAuditError(code, message, details, cause);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function listJavaScript(directory) {
  const files = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
      else if (!entry.isFile()) fail('ADMIN_RUNTIME_FILE_TYPE_INVALID', '管理员运行时包含不支持的文件类型', { target });
    }
  };
  visit(directory);
  return files.sort();
}

export async function auditAdminDeploymentRuntime({ projectRoot } = {}) {
  const project = path.resolve(projectRoot || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'admin'));
  const apiRoot = path.join(project, 'cloud-functions', 'api');
  const adminRoot = path.join(apiRoot, 'admin');
  if (!fs.existsSync(adminRoot) || !fs.statSync(adminRoot).isDirectory()) {
    fail('ADMIN_RUNTIME_API_ROOT_MISSING', '管理员Cloud Functions目录不存在', { adminRoot });
  }
  const allApiFiles = listJavaScript(apiRoot);
  const adminFiles = listJavaScript(adminRoot);
  if (!adminFiles.length || allApiFiles.length !== adminFiles.length) {
    fail('ADMIN_RUNTIME_API_SCOPE_INVALID', '管理员子项目包含非管理员API', {
      allApiFiles: allApiFiles.map(file => path.relative(project, file)),
      adminFiles: adminFiles.map(file => path.relative(project, file)),
    });
  }

  const imported = [];
  for (const file of adminFiles) {
    let module;
    try {
      module = await import(`${pathToFileURL(file).href}?stage8e=${Date.now()}-${imported.length}`);
    } catch (error) {
      fail('ADMIN_RUNTIME_IMPORT_FAILED', '管理员Cloud Function模块导入失败', {
        file: path.relative(project, file),
      }, error);
    }
    if (typeof module.default !== 'function') {
      fail('ADMIN_RUNTIME_DEFAULT_HANDLER_MISSING', '管理员Cloud Function缺少默认处理器', {
        file: path.relative(project, file),
      });
    }
    imported.push(path.relative(project, file).split(path.sep).join('/'));
  }
  return Object.freeze({
    verified: true,
    projectRoot: project,
    importedCount: imported.length,
    imported: Object.freeze(imported),
    anonymousApiIncluded: false,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await auditAdminDeploymentRuntime({
    projectRoot: argumentValue('--project-root'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
