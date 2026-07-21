import fs from 'node:fs';

const projectionPath = 'src/server/admin_ordinary_review_projection_v1.js';
const mutationPath = 'src/server/admin_ordinary_review_mutation_v1.js';

const projection = fs.readFileSync(projectionPath, 'utf8');
const projectionOld = `import {\n  ADMIN_REVIEW_MAX_OBJECTS,\n  adminReviewResolutionKey,\n  readAdminReviewConfig,\n  reviewIdForKey,\n} from './admin_review_projection_v1.js';`;
const projectionNew = `import {\n  ADMIN_REVIEW_MAX_OBJECTS,\n  readAdminReviewConfig,\n  reviewIdForKey,\n} from './admin_review_projection_v1.js';\nimport { adminReviewResolutionKey } from './admin_review_key_v1.js';`;

let nextProjection = projection;
if (projection.includes(projectionOld)) {
  nextProjection = projection.replace(projectionOld, projectionNew);
} else if (!projection.includes("from './admin_review_key_v1.js'")) {
  throw new Error('STAGE7T_PROJECTION_IMPORT_ANCHOR_NOT_FOUND');
}

const mutation = fs.readFileSync(mutationPath, 'utf8');
const mutationOld = `import {\n  adminReviewResolutionKey,\n} from './admin_review_projection_v1.js';`;
const mutationNew = `import {\n  adminReviewResolutionKey,\n} from './admin_review_key_v1.js';`;

let nextMutation = mutation;
if (mutation.includes(mutationOld)) {
  nextMutation = mutation.replace(mutationOld, mutationNew);
} else if (!mutation.includes("from './admin_review_key_v1.js'")) {
  throw new Error('STAGE7T_MUTATION_IMPORT_ANCHOR_NOT_FOUND');
}

fs.writeFileSync(projectionPath, nextProjection);
fs.writeFileSync(mutationPath, nextMutation);
console.log(JSON.stringify({
  projectionPatched: nextProjection !== projection,
  mutationPatched: nextMutation !== mutation,
}));
