import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'dist', 'index.html');
let html = fs.readFileSync(outputPath, 'utf8');

const constructorPattern = /\sconstructor\(app,\s*stores,\s*apiClient\)\s*\{[\s\S]*?this\._syncLocks\s*=\s*new Set\(\);\s*\}/;
const matches = html.match(new RegExp(constructorPattern.source, 'g')) || [];
if (matches.length !== 1) throw new Error(`阶段4C构造函数锚点数量异常：${matches.length}`);

html = html.replace(constructorPattern,
` constructor(app, stores, apiClient) {
   this.app = app;
   this.stores = stores;
   this.apiClient = apiClient;
   this._eventScope = new FeatureEventScope();
   this.selectedLocalLibraryId = '';
   this.lastError = null;
   this.lastServerError = null;
   this.lastPublicVersion = null;
   this._readonlyCheckScheduled = false;
   this._receivePollTimer = null;
   this._syncLocks = new Set();
  }`);

fs.writeFileSync(outputPath, html, 'utf8');
