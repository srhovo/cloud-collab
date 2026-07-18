import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(root, 'dist', 'stage4f-real-device-acceptance.html'), 'utf8');

test('stage4F acceptance inline runtime parses as JavaScript', () => {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
});

test('stage4F acceptance page is visibly temporary and hard-locked to the fixture scope', () => {
  assert.match(page, /DO NOT MERGE/);
  assert.match(page, /const GROUP_ID = 'group_fixture'/);
  assert.match(page, /const LIBRARY_ID = 'lib_receive_fixture'/);
  assert.match(page, /只允许 group_fixture \/ lib_receive_fixture/);
  assert.doesNotMatch(page, /CLOUD_WRITE_ALLOWED_GROUP_ID\s*=/);
  assert.doesNotMatch(page, /CLOUD_WRITE_ALLOWED_LIBRARY_ID\s*=/);
});

test('acceptance page loads the real 8.2.28 build and uses its persistent dispatcher queue', () => {
  assert.match(page, /routedFetch\('\/index\.html'/);
  assert.match(page, /const APP_VERSION = '8\.2\.28';/);
  assert.match(page, /pendingCloudChanges/);
  assert.match(page, /cloudCollabSubmissionDispatcher\.isOnline/);
  assert.match(page, /cloudCollabFeature\.flushPendingUploads/);
  assert.match(page, /CloudCollabSubmission\.buildExactPriceSubmission/);
  assert.match(page, /coordinator\.enqueueSubmission/);
});

test('formal client paths are rewritten only in the acceptance runtime to isolated stage4E routes', () => {
  assert.match(page, /'\/api\/submissions\/create': '\/api\/preview\/submissions\/create'/);
  assert.match(page, /'\/api\/public-version': '\/api\/preview\/public-version'/);
  assert.match(page, /'\/api\/public-snapshot': '\/api\/preview\/public-snapshot'/);
  assert.match(page, /'\/api\/public-changes': '\/api\/preview\/public-changes'/);
  assert.match(page, /sourcePath === '\/api\/device\/register'/);
  assert.match(page, /headers\.set\(PREVIEW_HEADER, state\.activeKey\)/);
  assert.match(page, /url\.origin !== window\.location\.origin/);
});

test('preview key stays in memory and is cleared on input, session close, and pagehide', () => {
  assert.match(page, /activeKey: ''/);
  assert.match(page, /els\.previewKey\.value = ''/);
  assert.match(page, /state\.activeKey = ''/);
  assert.match(page, /pagehide/);
  assert.doesNotMatch(page, /(?:localStorage|sessionStorage)\.setItem/);
  assert.doesNotMatch(page, /indexedDB\.(?:open|deleteDatabase)/);
  assert.doesNotMatch(page, /console\.(?:log|warn|error)/);
  assert.doesNotMatch(page, /CLOUD_WRITE_PREVIEW_KEY\s*=\s*['"][^'"]+/);
});

test('acceptance page covers review results, dynamic consistency, cross-device fingerprint, and offline recovery', () => {
  assert.match(page, /waiting_confirmation/);
  assert.match(page, /auto_approved/);
  assert.match(page, /pending_review/);
  assert.match(page, /previewMutationApplied/);
  assert.match(page, /publicVersion === snapshotVersion/);
  assert.match(page, /publicVersion === changesVersion/);
  assert.match(page, /shortFingerprint/);
  assert.match(page, /simulatedOffline/);
  assert.match(page, /OFFLINE_QUEUE_HELD/);
  assert.match(page, /RECOVERY_RETRY_OK/);
});

test('main user routes remain separate from the stage4F page', () => {
  const currentSubmission = fs.readFileSync(path.join(root, 'cloud-functions', 'api', 'submissions', 'create.js'), 'utf8');
  const previewSubmission = fs.readFileSync(path.join(root, 'cloud-functions', 'api', 'preview', 'submissions', 'create.js'), 'utf8');
  const formalIndexSource = fs.readFileSync(path.join(root, 'src', '码单器8.2.26_公共协作本地候选版.html'), 'utf8');
  assert.match(currentSubmission, /handleSubmissionCreateRequest/);
  assert.doesNotMatch(currentSubmission, /handlePreviewAutoApprovalSubmissionRequest/);
  assert.match(previewSubmission, /handlePreviewAutoApprovalSubmissionRequest/);
  assert.doesNotMatch(formalIndexSource, /stage4f-real-device-acceptance/);
});
