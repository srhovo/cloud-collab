import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(`${new URL('./build-stage6b.mjs', import.meta.url).href}?compatible=${Date.now()}`);

const outputPath = path.join(root, 'dist', 'index.html');
const manifestPath = path.join(root, 'dist', 'build-manifest.json');
const adminPagePath = path.join(root, 'dist', 'admin-sensitive-reviews-preview.html');
let html = fs.readFileSync(outputPath, 'utf8');

function replaceExact(text, search, replacement, label, { allowMany = false } = {}) {
  const count = text.split(search).length - 1;
  if (count < 1 || (!allowMany && count !== 1)) {
    throw new Error(`${label}锚点数量无效：${count}`);
  }
  return allowMany ? text.split(search).join(replacement) : text.replace(search, replacement);
}

const stageTitle = '<title>码单器8.2.31（敏感候选人工审核协作版）</title>';
const candidateTitle = '<title>码单器8.2.31（公共协作发布候选版）</title>';
const appVersionAnchor = "const APP_VERSION = '8.2.28';";
const appVersionReplacement = "const APP_VERSION = '8.2.31';";
const versionCount = html.split(appVersionAnchor).length - 1;
if (versionCount < 1) throw new Error(`候选APP_VERSION锚点数量无效：${versionCount}`);

html = replaceExact(html, stageTitle, candidateTitle, '阶段7J候选标题');
html = replaceExact(html, appVersionAnchor, appVersionReplacement, '阶段7J APP_VERSION', { allowMany: true });
html = replaceExact(html, 'placeholder="例如：小雪"', 'placeholder="例如：下雪"', '设备昵称示例');
html = replaceExact(html, '<label for="cloudGroupIdInput">groupId</label>', '<label for="cloudGroupIdInput">club</label>', 'club显示标签');
html = replaceExact(
  html,
  '<input id="cloudGroupIdInput" type="text" maxlength="54" autocomplete="off" placeholder="group_xiacijian">',
  '<input id="cloudGroupIdInput" type="text" maxlength="54" autocomplete="off" placeholder="club_id" pattern="[a-z0-9_]+" inputmode="text" autocapitalize="none" spellcheck="false" title="club ID仅支持小写英文字母、数字和下划线，不支持中文">',
  'club ID输入框',
);
html = replaceExact(
  html,
  '<input id="cloudLibraryIdInput" type="text" maxlength="60" autocomplete="off" placeholder="lib_regular">',
  '<input id="cloudLibraryIdInput" type="text" maxlength="60" autocomplete="off" placeholder="lib_regular" pattern="[a-z0-9_]+" inputmode="text" autocapitalize="none" spellcheck="false" title="library ID仅支持小写英文字母、数字和下划线，不支持中文">\n <small class="cloud-collab-status cloud-collab-field--wide" id="cloudIdentifierFormatHint">club ID 与 library ID 仅支持小写英文字母、数字和下划线，不支持中文。</small>',
  'library ID输入框与格式提示',
);

const identifierGuard = `
// ===== 阶段7J：club/library ASCII ID失败关闭 =====
(() => {
 const allowed = /^[a-z0-9_]+$/;
 const ids = ['cloudGroupIdInput', 'cloudLibraryIdInput'];
 const message = 'ID仅支持小写英文字母、数字和下划线，不支持中文';
 const validate = input => {
  const value = String(input?.value || '').trim();
  const valid = Boolean(value) && allowed.test(value);
  input?.setCustomValidity?.(valid ? '' : message);
  return valid;
 };
 document.addEventListener('input', event => {
  if (ids.includes(event.target?.id)) validate(event.target);
 }, true);
 document.addEventListener('click', event => {
  if (event.target?.id !== 'cloudBindingSaveBtn') return;
  const inputs = ids.map(id => document.getElementById(id)).filter(Boolean);
  const invalid = inputs.find(input => !validate(input));
  if (!invalid) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  invalid.reportValidity?.();
  invalid.focus?.();
 }, true);
})();
// ===== 阶段7J：club/library ASCII ID失败关闭结束 =====
`;
html = replaceExact(html, '</script>\n</body>', `${identifierGuard}</script>\n</body>`, '唯一内联脚本结束标签');

if (html.includes(appVersionAnchor)) throw new Error('候选构建仍残留8.2.28 APP_VERSION锚点');
if (html.includes('placeholder="例如：小雪"') || html.includes('placeholder="group_xiacijian"')) {
  throw new Error('阶段7J候选仍残留旧界面示例');
}
if ((html.match(/<script\b/gi) || []).length !== 1) throw new Error('阶段7J候选必须保留单一内联脚本');
fs.writeFileSync(outputPath, html, 'utf8');

let adminPage = fs.readFileSync(adminPagePath, 'utf8');
const ignoredMetaDirective = "; frame-ancestors 'none'";
const metaCount = adminPage.split(ignoredMetaDirective).length - 1;
if (metaCount > 1) throw new Error(`阶段6B管理员页面frame-ancestors元指令数量无效：${metaCount}`);
if (metaCount === 1) {
  adminPage = adminPage.replace(ignoredMetaDirective, '');
  fs.writeFileSync(adminPagePath, adminPage, 'utf8');
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = '8.2.31';
manifest.compatibleShellRetained = true;
manifest.candidateVersionApproved = true;
manifest.candidateAppVersionReplacementCount = versionCount;
manifest.stablePromotionPerformed = false;
manifest.adminFrameAncestorsHeaderOnly = true;
manifest.clubDisplayLabelEnabled = true;
manifest.legacyGroupIdProtocolRetained = true;
manifest.identifierAsciiValidationEnabled = true;
manifest.singleInlineScriptRetained = true;
manifest.nicknameExample = '下雪';
manifest.publicJsonUtf8CharsetRequired = true;
manifest.sha256 = crypto.createHash('sha256').update(Buffer.from(html)).digest('hex');
manifest.bytes = Buffer.byteLength(html);
manifest.generatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify(manifest, null, 2));
