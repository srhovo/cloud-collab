import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'dist', 'index.html');
const featurePath = path.join(root, 'src', 'cloud_collab_readonly_feature_methods.fragment.js');
let html = fs.readFileSync(outputPath, 'utf8');
const fragment = fs.readFileSync(featurePath, 'utf8').trim();

const fragmentIndex = html.indexOf(fragment);
if (fragmentIndex < 0 || html.indexOf(fragment, fragmentIndex + fragment.length) >= 0) {
  throw new Error('阶段4C只读方法片段数量异常');
}
const methodToken = 'getModeLabel(mode) {';
const methodIndex = html.indexOf(methodToken, fragmentIndex + fragment.length);
if (methodIndex < 0) throw new Error('阶段4C未找到getModeLabel锚点');
const region = html.slice(fragmentIndex + fragment.length, methodIndex);
if (!/^\s*$/.test(region)) throw new Error('阶段4C只读方法与getModeLabel之间存在未知内容');
const lineStart = html.lastIndexOf('\n', fragmentIndex - 1) + 1;
html = html.slice(0, lineStart)
  + ` ${fragment}\n\n  ${methodToken}`
  + html.slice(methodIndex + methodToken.length);

fs.writeFileSync(outputPath, html, 'utf8');
