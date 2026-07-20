import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
let passed = 0;
const failures = [];

function file(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function check(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`ok ${passed} - ${label}`);
  } else {
    failures.push(label);
    console.error(`not ok - ${label}`);
  }
}

function exactEnvDefault(source, name, expected) {
  const pattern = new RegExp(`^${name}=${expected.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}$`, 'm');
  return pattern.test(source);
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
}

const requiredFiles = [
  'docs/阶段5G6A6B_EdgeOne联合验收范围冻结.md',
  'src/server/stage5g6a6b_acceptance_v1.js',
  'src/server/stage5g6a6b_acceptance_http_v1.js',
  'src/server/stage5g6a6b_acceptance_proxy_http_v1.js',
  'src/server/stage5g6a6b_cleanup_v1.js',
  'src/server/stage5g6a6b_cleanup_http_v1.js',
  'cloud-functions/api/stage5g6a6b/acceptance/seed.js',
  'cloud-functions/api/stage5g6a6b/acceptance/status.js',
  'cloud-functions/api/stage5g6a6b/acceptance/device-register.js',
  'cloud-functions/api/stage5g6a6b/acceptance/ordinary-submissions-create.js',
  'cloud-functions/api/stage5g6a6b/acceptance/sensitive-submissions-create.js',
  'cloud-functions/api/stage5g6a6b/acceptance/public-version.js',
  'cloud-functions/api/stage5g6a6b/acceptance/public-snapshot.js',
  'cloud-functions/api/stage5g6a6b/acceptance/public-changes.js',
  'cloud-functions/api/stage5g6a6b/cleanup.js',
  'dist/stage5g6a6b-acceptance.html',
  'dist/stage5g6a6b-cleanup.html',
  'tests/stage5g6a6b-acceptance.test.mjs',
  'tests/stage5g6a6b-proxy.test.mjs',
  'tests/stage5g6a6b-cleanup.test.mjs',
];
for (const relativePath of requiredFiles) {
  check(fs.existsSync(path.join(root, relativePath)), `存在 ${relativePath}`);
}

const envSource = file('.env.example');
check(exactEnvDefault(envSource, 'CLOUD_STAGE5G6A6B_ACCEPTANCE_ENABLED', '0'), '联合验收门禁默认关闭');
check(exactEnvDefault(envSource, 'CLOUD_STAGE5G6A6B_ACCEPTANCE_KEY', ''), '联合验收密钥默认留空');
check(exactEnvDefault(envSource, 'CLOUD_STAGE5G6A6B_CLEANUP_ENABLED', '0'), '联合清理门禁默认关闭');
check(exactEnvDefault(envSource, 'CLOUD_STAGE5G6A6B_CLEANUP_CONFIRMATION', ''), '联合清理确认默认留空');
check(exactEnvDefault(envSource, 'CLOUD_STAGE5G6A6B_CLEANUP_KEY', ''), '联合清理密钥默认留空');
check(exactEnvDefault(envSource, 'CLOUD_WRITE_PREVIEW_ENABLED', '0'), '正式公共写入门禁默认关闭');
check(exactEnvDefault(envSource, 'CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED', '0'), '正式自动批准门禁默认关闭');

const scopeDoc = file('docs/阶段5G6A6B_EdgeOne联合验收范围冻结.md');
check(scopeDoc.includes('[DO NOT MERGE]'), '范围文档标记绝不合并');
check(scopeDoc.includes('CLOUD_WRITE_PREVIEW_ENABLED=0'), '范围文档要求正式公共写入关闭');
check(scopeDoc.includes('CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED=0'), '范围文档要求正式自动批准关闭');
check(scopeDoc.includes('一次性代理'), '范围文档明确一次性代理边界');
check(scopeDoc.includes('第二次独立强一致复查'), '范围文档要求第二次独立零对象复查');
check(scopeDoc.includes('关闭 PR') && scopeDoc.includes('绝不合并'), '范围文档冻结关闭未合并生命周期');

const acceptanceCore = file('src/server/stage5g6a6b_acceptance_v1.js');
const acceptanceHttp = file('src/server/stage5g6a6b_acceptance_http_v1.js');
const proxyHttp = file('src/server/stage5g6a6b_acceptance_proxy_http_v1.js');
const cleanupCore = file('src/server/stage5g6a6b_cleanup_v1.js');
check(acceptanceCore.includes('STAGE5G6A6B_ACCEPTANCE_CLEANUP_CONFLICT'), '验收与清理互斥失败关闭');
check(acceptanceCore.includes('group_fixture') && acceptanceCore.includes('lib_receive_fixture'), '验收核心硬锁 fixture 作用域');
check(acceptanceCore.includes('cloud-collab-preview-v1') && acceptanceCore.includes('cloud-collab-admin-preview-v1'), '验收核心硬锁两套合成 Blob');
check(acceptanceHttp.includes('STAGE5G6A6B_FORMAL_PUBLIC_MUTATION_MUST_BE_CLOSED'), '验收控制路由拒绝正式公共写入门禁开启');
check(proxyHttp.includes("CLOUD_WRITE_PREVIEW_ENABLED: '1'"), '一次性代理只在请求内部启用 fixture 写入');
check(proxyHttp.includes("CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '1'"), '普通代理只在请求内部启用 fixture 自动审核');
check(proxyHttp.includes("CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED: '0'"), '普通代理避开敏感读取锁并保持路由隔离');
check(cleanupCore.includes('STAGE5G6A6B_CLEANUP_UNSAFE_OBJECTS'), '清理器未知对象删除前失败关闭');
check(cleanupCore.includes('STAGE5G6A6B_CLEANUP_KEYSET_CHANGED'), '清理执行绑定检查摘要');
check(cleanupCore.includes('consistency: \'strong\''), '清理器使用强一致列举');
check(cleanupCore.includes('CLOUD_STAGE5G6A6B_ACCEPTANCE_ENABLED') && cleanupCore.includes('CLOUD_ADMIN_PREVIEW_ENABLED'), '清理前要求验收与管理员能力关闭');

const pages = [
  ['dist/stage5g6a6b-acceptance.html', file('dist/stage5g6a6b-acceptance.html')],
  ['dist/stage5g6a6b-cleanup.html', file('dist/stage5g6a6b-cleanup.html')],
];
for (const [relativePath, html] of pages) {
  check(!/localStorage|sessionStorage/i.test(html), `${relativePath} 不使用浏览器持久化存储`);
  check(!/acceptance-key-[a-z]|cleanup-key-[a-z]|admin-password-/i.test(html), `${relativePath} 不包含测试或真实秘密值`);
  check(html.includes("default-src 'none'"), `${relativePath} 使用失败关闭 CSP`);
  const scripts = inlineScripts(html);
  check(scripts.length === 1, `${relativePath} 只有一个内联脚本`);
  let syntaxOk = scripts.length === 1;
  if (syntaxOk) {
    try { new vm.Script(scripts[0], { filename: relativePath }); }
    catch (error) {
      syntaxOk = false;
      console.error(error.stack || error.message);
    }
  }
  check(syntaxOk, `${relativePath} 内联 JavaScript 语法有效`);
}

const acceptancePage = pages[0][1];
const cleanupPage = pages[1][1];
check(acceptancePage.includes('eo_token') && acceptancePage.includes('eo_time'), '联合验收页面转发 EdgeOne 预览查询参数');
check(acceptancePage.includes('清除页面内存'), '联合验收页面提供内存清除动作');
check(cleanupPage.includes('第一次独立强一致复查') && cleanupPage.includes('第二次独立强一致复查'), '清理页面要求两次独立零对象复查');
check(cleanupPage.includes('expectedPublicKeySetDigest') && cleanupPage.includes('expectedAdminKeySetDigest'), '清理页面按两套摘要绑定删除');

const packageJson = JSON.parse(file('package.json'));
check(!String(packageJson.scripts?.build || '').includes('码单器8.2.25'), '活动构建不读取冻结稳定文件');
check(!JSON.stringify(packageJson.scripts || {}).includes('stage5g6a6b-acceptance.html'), '一次性验收页面不进入稳定候选构建链');

if (failures.length) {
  console.error(`\n阶段5G+6A+6B联合验收静态门禁失败：${failures.length}项`);
  process.exit(1);
}
console.log(`\n阶段5G+6A+6B联合验收静态门禁通过：${passed}/${passed}`);
