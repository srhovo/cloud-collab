import fs from 'node:fs';
const file = 'src/server/production_admin_review_http_v1.js';
const source = fs.readFileSync(file, 'utf8');
const next = source
  .replace('storeName: runtime.storeName,', 'storeName: runtime.publicStoreName,')
  .replace('groupId: runtime.groupId,', 'groupId: runtime.scope.protocol.groupId,')
  .replace('libraryId: runtime.libraryId,', 'libraryId: runtime.scope.protocol.libraryId,');
if (!next.includes('storeName: runtime.publicStoreName,')
    || !next.includes('groupId: runtime.scope.protocol.groupId,')
    || !next.includes('libraryId: runtime.scope.protocol.libraryId,')) {
  throw new Error('STAGE7T_RUNTIME_CONFIG_SHAPE_PATCH_FAILED');
}
fs.writeFileSync(file, next);
console.log(JSON.stringify({ changed: next !== source }));
