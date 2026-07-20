import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOUD_FUNCTIONS_ROOT = path.join(ROOT, 'cloud-functions');

function walkJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJavaScriptFiles(absolutePath));
    else if (entry.isFile() && /\.[cm]?js$/i.test(entry.name)) files.push(absolutePath);
  }
  return files;
}

function relativeImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function resolveImport(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.js'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.cjs'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

test('所有Cloud Functions相对导入都能解析到仓库内真实文件', () => {
  assert.equal(fs.existsSync(CLOUD_FUNCTIONS_ROOT), true, 'cloud-functions目录不存在');
  const failures = [];
  for (const importer of walkJavaScriptFiles(CLOUD_FUNCTIONS_ROOT)) {
    const source = fs.readFileSync(importer, 'utf8');
    for (const specifier of relativeImportSpecifiers(source)) {
      if (!resolveImport(importer, specifier)) {
        failures.push({ importer: path.relative(ROOT, importer), specifier });
      }
    }
  }
  assert.deepEqual(failures, [], `发现无法解析的Cloud Functions相对导入：\n${JSON.stringify(failures, null, 2)}`);
});
