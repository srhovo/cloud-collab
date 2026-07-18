import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const deviceRoutePath = 'cloud-functions/api/device/register.js';
const submissionRoutePath = 'cloud-functions/api/submissions/create.js';
const sharedPath = 'cloud-functions/api/_shared/preview-write-http.js';

const deviceRoute = read(deviceRoutePath);
const submissionRoute = read(submissionRoutePath);
const shared = read(sharedPath);
const productionRoutes = `${deviceRoute}\n${submissionRoute}\n${shared}`;

test('write handlers live only in Node Cloud Functions and no Edge POST route is introduced', () => {
  assert.equal(fs.existsSync(path.join(root, deviceRoutePath)), true);
  assert.equal(fs.existsSync(path.join(root, submissionRoutePath)), true);
  assert.equal(fs.existsSync(path.join(root, 'edge-functions/api/device/register.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'edge-functions/api/submissions/create.js')), false);
  assert.match(deviceRoute, /src\/server\/device_registration_v1\.js/);
  assert.match(submissionRoute, /src\/server\/submission_acceptance_v1\.js/);
  assert.match(shared, /from '@edgeone\/pages-blob'/);
});

test('preview write gate is disabled by default and requires a separate secret header', () => {
  const envExample = read('.env.example');
  assert.match(envExample, /CLOUD_COLLAB_WRITE_PREVIEW_ENABLED=false/);
  assert.match(envExample, /CLOUD_COLLAB_WRITE_PREVIEW_KEY=\s*(?:\r?\n|$)/);
  assert.match(shared, /WRITE_PREVIEW_DISABLED/);
  assert.match(shared, /WRITE_PREVIEW_KEY_NOT_CONFIGURED/);
  assert.match(shared, /WRITE_PREVIEW_ACCESS_DENIED/);
  assert.match(shared, /x-cloud-collab-preview-key/);
  assert.match(shared, /timingSafeEqual/);
  assert.doesNotMatch(productionRoutes, /preview_test_key_0123456789/);
});

test('submission route is hard-limited to the isolated fixture scope', () => {
  assert.match(shared, /group_fixture/);
  assert.match(shared, /lib_receive_fixture/);
  assert.match(submissionRoute, /assertPreviewSubmissionScope/);
  assert.doesNotMatch(productionRoutes, /group_xiacijian/);
  assert.doesNotMatch(productionRoutes, /lib_xiacijian_regular/);
});

test('all public mutation and automatic approval capabilities remain false', () => {
  assert.match(deviceRoute, /publicMutationAllowed:\s*false/);
  assert.match(deviceRoute, /autoApprovalEnabled:\s*false/);
  assert.match(deviceRoute, /submissionEnabled:\s*false/);
  assert.match(submissionRoute, /publicMutationAllowed:\s*false/);
  assert.match(submissionRoute, /autoApprovalEnabled:\s*false/);
  assert.doesNotMatch(productionRoutes, /publicMutationAllowed:\s*true/);
  assert.doesNotMatch(productionRoutes, /autoApprovalEnabled:\s*true/);
  assert.doesNotMatch(productionRoutes, /approved_by_admin|auto_approved/);
});

test('Blob access defaults to a separate preview namespace with strong reads', () => {
  assert.match(shared, /cloud-collab-preview-private/);
  assert.match(shared, /consistency:\s*'strong'/);
  assert.match(shared, /CLOUD_COLLAB_PRIVATE_BLOB_STORE/);
  const repository = read('src/server/blob_repository_v1.js');
  assert.match(repository, /onlyIfNew:\s*true/);
  assert.match(repository, /type:\s*'json',\s*consistency:\s*'strong'/);
});

test('routes are no-store, JSON-only and bounded before service invocation', () => {
  assert.match(shared, /Cache-Control': 'no-store/);
  assert.match(shared, /application\/json/);
  assert.match(deviceRoute, /8 \* 1024/);
  assert.match(submissionRoute, /MAX_SUBMISSION_BYTES/);
  assert.ok(deviceRoute.indexOf('await readJsonBody') < deviceRoute.indexOf('await registerDevice'));
  assert.ok(submissionRoute.indexOf('await readJsonBody') < submissionRoute.indexOf('await acceptSubmission'));
  assert.ok(submissionRoute.indexOf('assertPreviewSubmissionScope(body.value)') < submissionRoute.indexOf('await acceptSubmission'));
});

test('Stage3B public read protocol stays unchanged and read-only', () => {
  const protocol = read('edge-functions/api/protocol.js');
  const health = read('edge-functions/api/health.js');
  assert.match(protocol, /snapshotRead:\s*true/);
  assert.match(protocol, /incrementalRead:\s*true/);
  assert.match(protocol, /submission:\s*false/);
  assert.match(protocol, /adminReview:\s*false/);
  assert.match(health, /submission:\s*false/);
  assert.match(health, /adminWrite:\s*false/);
  assert.doesNotMatch(`${protocol}\n${health}`, /writeEnabled:\s*true/);
});

test('Blob SDK version is exact and no real secret is committed', () => {
  const packageJson = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(packageJson.dependencies['@edgeone/pages-blob'], '0.0.14');
  assert.equal(lock.packages['node_modules/@edgeone/pages-blob'].version, '0.0.14');
  assert.doesNotMatch(productionRoutes, /CLOUD_COLLAB_WRITE_PREVIEW_KEY\s*=\s*[^\s'"`]{16,}/);
  assert.doesNotMatch(productionRoutes, /console\.(?:log|info|warn|error)\s*\(/);
});
