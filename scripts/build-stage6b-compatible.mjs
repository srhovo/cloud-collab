import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(`${new URL('./build-stage6b.mjs', import.meta.url).href}?compatible=${Date.now()}`);

const outputPath = path.join(root, 'dist', 'index.html');
const manifestPath = path.join(root, 'dist', 'build-manifest.json');
let html = fs.readFileSync(outputPath, 'utf8');
const stageTitle = '<title>码单器8.2.31（敏感候选人工审核协作版）</title>';
const compatibleTitle = '<title>码单器8.2.28（公共协作候选派发客户端）</title>';
const count = html.split(stageTitle).length - 1;
if (count !== 1) throw new Error(`阶段6B兼容壳标题锚点数量无效：${count}`);
html = html.replace(stageTitle, compatibleTitle);
fs.writeFileSync(outputPath, html, 'utf8');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = '8.2.28';
manifest.compatibleShellRetained = true;
manifest.sha256 = crypto.createHash('sha256').update(Buffer.from(html)).digest('hex');
manifest.bytes = Buffer.byteLength(html);
manifest.generatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify(manifest, null, 2));
