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
const stageTitle = '<title>码单器8.2.31（敏感候选人工审核协作版）</title>';
const candidateTitle = '<title>码单器8.2.30（公共协作发布候选版）</title>';
const appVersionAnchor = "const APP_VERSION = '8.2.28';";
const appVersionReplacement = "const APP_VERSION = '8.2.30';";
const titleCount = html.split(stageTitle).length - 1;
if (titleCount !== 1) throw new Error(`阶段6B兼容壳标题锚点数量无效：${titleCount}`);
const versionCount = html.split(appVersionAnchor).length - 1;
if (versionCount < 1) throw new Error(`候选APP_VERSION锚点数量无效：${versionCount}`);
html = html
  .replace(stageTitle, candidateTitle)
  .split(appVersionAnchor).join(appVersionReplacement);
if (html.includes(appVersionAnchor)) throw new Error('候选构建仍残留8.2.28 APP_VERSION锚点');
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
manifest.version = '8.2.30';
manifest.compatibleShellRetained = true;
manifest.candidateVersionApproved = true;
manifest.candidateAppVersionReplacementCount = versionCount;
manifest.stablePromotionPerformed = false;
manifest.adminFrameAncestorsHeaderOnly = true;
manifest.sha256 = crypto.createHash('sha256').update(Buffer.from(html)).digest('hex');
manifest.bytes = Buffer.byteLength(html);
manifest.generatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify(manifest, null, 2));
