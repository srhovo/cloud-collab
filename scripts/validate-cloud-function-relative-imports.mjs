import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const functionsRoot = path.join(root, 'cloud-functions');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

const importPattern = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
const failures = [];
let checked = 0;

for (const filePath of walk(functionsRoot)) {
  const source = fs.readFileSync(filePath, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    const resolved = path.resolve(path.dirname(filePath), specifier);
    checked += 1;
    if (!fs.existsSync(resolved)) {
      failures.push(`${path.relative(root, filePath)} -> ${specifier}`);
    }
  }
}

if (failures.length) {
  throw new Error(`Cloud Functions 相对导入无法解析：\n${failures.join('\n')}`);
}

console.log(`Cloud Functions 相对导入门禁通过：${checked} 条`);
