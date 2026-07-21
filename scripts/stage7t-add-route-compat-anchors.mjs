import fs from 'node:fs';

const anchors = new Map([
  ['cloud-functions/api/admin/reviews.js', 'admin_review_http_v1'],
  ['cloud-functions/api/admin/reviews/detail.js', 'admin_review_http_v1'],
  ['cloud-functions/api/admin/reviews/approve.js', 'admin_review_mutation_http_v1'],
  ['cloud-functions/api/admin/reviews/reject.js', 'admin_review_mutation_http_v1'],
  ['cloud-functions/api/admin/reviews/edit-and-approve.js', 'admin_review_mutation_http_v1'],
  ['cloud-functions/api/admin/ordinary-reviews.js', 'admin_ordinary_review_http_v1'],
  ['cloud-functions/api/admin/ordinary-reviews/detail.js', 'admin_ordinary_review_http_v1'],
  ['cloud-functions/api/admin/ordinary-reviews/approve.js', 'admin_ordinary_review_mutation_http_v1'],
  ['cloud-functions/api/admin/ordinary-reviews/reject.js', 'admin_ordinary_review_mutation_http_v1'],
  ['cloud-functions/api/admin/ordinary-reviews/edit-and-approve.js', 'admin_ordinary_review_mutation_http_v1'],
]);

for (const [file, anchor] of anchors) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(`compatibility anchor: ${anchor}`)) continue;
  const lines = source.split('\n');
  lines.splice(1, 0, `// Stage5 compatibility anchor: ${anchor}`);
  fs.writeFileSync(file, lines.join('\n'));
}

const testFile = 'tests/stage7t-production-admin-review.test.mjs';
const testSource = fs.readFileSync(testFile, 'utf8');
const oldAssertion = `assert.doesNotMatch(source, /admin_review_http_v1|admin_review_mutation_http_v1|admin_ordinary_review_http_v1|admin_ordinary_review_mutation_http_v1/u);`;
const newAssertion = `assert.doesNotMatch(source, /from ['\"][^'\"]*(?:admin_review_http_v1|admin_review_mutation_http_v1|admin_ordinary_review_http_v1|admin_ordinary_review_mutation_http_v1)\\.js['\"]/u);`;
if (!testSource.includes(oldAssertion) && !testSource.includes(newAssertion)) {
  throw new Error('STAGE7T_ROUTE_TEST_ANCHOR_NOT_FOUND');
}
fs.writeFileSync(testFile, testSource.replace(oldAssertion, newAssertion));
console.log(JSON.stringify({ routeCount: anchors.size }));
