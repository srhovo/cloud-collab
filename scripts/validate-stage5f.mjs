import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const env = read('.env.example');
const bundle = read('src/server/admin_export_bundle_v1.js');
const service = read('src/server/admin_export_v1.js');
const http = read('src/server/admin_export_http_v1.js');
const page = read('dist/admin-export-preview.html');
const workflow = read('.github/workflows/ci.yml');
const ordinary = read('dist/index.html');
const submissionClient = read('src/cloud_collab_submission_client.js');
const scopeDoc = read('docs/阶段5F_管理员公共数据库导出范围冻结.md');

check('Stage5F gate defaults closed', env.includes('CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED=0'));
check('Stage5F Blob and fixture scope are explicit', [
  'CLOUD_ADMIN_EXPORT_BLOB_STORE_NAME=cloud-collab-preview-v1',
  'CLOUD_ADMIN_EXPORT_ALLOWED_GROUP_ID=group_fixture',
  'CLOUD_ADMIN_EXPORT_ALLOWED_LIBRARY_ID=lib_receive_fixture',
].every(token => env.includes(token)));
check('Stage5F audit salt is configured separately', env.includes('CLOUD_ADMIN_EXPORT_AUDIT_SALT='));
check('Stage5F ZIP is generated in request memory', bundle.includes('createStoredZip') && !bundle.includes('setJSON(') && !bundle.includes('public download'));
check('Stage5F package has portable fixed directories', [
  '/manifest.json', '/schema.json', '/groups.json', '/libraries/', '/bosses/index.json',
  '/playable-names/index.json', '/rules/index.json', '/audit/public-events.json', '/audit/rollbacks.json',
].every(token => bundle.includes(token)));
check('Stage5F enforces package and object limits', bundle.includes('10 * 1024 * 1024') && bundle.includes('10_000'));
check('Stage5F validates public event chain and rollback linkage', bundle.includes('ADMIN_EXPORT_EVENT_CHAIN_INVALID') && bundle.includes('ADMIN_EXPORT_ROLLBACK_EVENT_MISMATCH'));
check('Stage5F uses fixed explicit confirmation', service.includes("ADMIN_EXPORT_CONFIRMATION = 'EXPORT_SYNTHETIC_PUBLIC_DATABASE'") && page.includes("confirmation:'EXPORT_SYNTHETIC_PUBLIC_DATABASE'"));
check('Stage5F request, decision and audit records are immutable', service.includes('exports/${config.libraryId}/requests/') && service.includes('exports/${config.libraryId}/decisions/') && service.includes("action: 'admin_export'") && service.includes('putJSONOnlyIfNew'));
check('Stage5F response projection forbids internal identities', ['deviceId','submissionId','approvalId','eventKey','requestHash','auditId','actorTag'].every(key => service.includes(`'${key}'`)));
check('Stage5F POST requires same-origin administrator session', http.includes('requireOrigin: true') && http.includes('publicOrigin: authConfig.publicOrigin') && http.includes('verifyAdminSessionToken'));
check('Stage5F emits ZIP attachment with metadata', http.includes("'Content-Type': bundle.contentType") && http.includes("'Content-Disposition'") && http.includes("'X-Mdq-Package-Id'"));
check('Stage5F page persists no export state', !/(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)/.test(page));
check('Stage5F page has exact unique download control', (page.match(/>下载标准导出包</g) || []).length === 1);
check('Stage5F ordinary user build has no administrator export route', !ordinary.includes('admin-export-preview') && !ordinary.includes('/api/admin/exports') && !submissionClient.includes('/api/admin'));
check('Stage5F scope document preserves combined EdgeOne acceptance', scopeDoc.includes('阶段5D设备治理') && scopeDoc.includes('阶段5E公共数据回滚') && scopeDoc.includes('阶段5F公共数据库导出'));
check('CI includes Stage5F browser regression', workflow.includes('tests/stage5f_browser_admin_export.py'));

const failed = checks.filter(item => !item.ok);
console.log(JSON.stringify({ stage: '5F', total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
