import fs from 'node:fs';

const file = 'src/server/production_admin_review_http_v1.js';
const source = fs.readFileSync(file, 'utf8');
const next = source
  .replace('groupId: runtime.protocolScope.groupId,', 'groupId: runtime.groupId,')
  .replace('libraryId: runtime.protocolScope.libraryId,', 'libraryId: runtime.libraryId,');
if (next === source && (!source.includes('groupId: runtime.groupId,') || !source.includes('libraryId: runtime.libraryId,'))) {
  throw new Error('STAGE7T_RUNTIME_SCOPE_ANCHOR_NOT_FOUND');
}
fs.writeFileSync(file, next);
console.log(JSON.stringify({ changed: next !== source }));
