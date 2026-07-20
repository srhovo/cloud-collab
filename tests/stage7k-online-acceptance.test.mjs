import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledger = JSON.parse(fs.readFileSync(path.join(root, 'release', 'release-closure-ledger-v1.json'), 'utf8'));

test('阶段7K记录8.2.31线上与真实网络验收且不晋升稳定版', () => {
  assert.equal(ledger.currentCompatibleCandidateVersion, '8.2.31');
  assert.equal(ledger.evidence.automated.stage7jMainCommit, 'e0d648216e4be5e89774610681bb71d6741c4879');
  assert.equal(ledger.evidence.automated.stage7jNodeTestCount, 301);
  assert.equal(ledger.evidence.automated.stage7jNodeTestFailures, 0);
  assert.equal(ledger.evidence.automated.stage7jCandidateSha256, '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b');
  assert.equal(ledger.evidence.automated.stage7jCandidateBytes, 1155575);

  const real = ledger.evidence.realDevice;
  for (const key of [
    'stage7jEdgeOneCandidateDeployment',
    'stage7jCandidateVersionAndDigest',
    'stage7jClubLabelAndPlaceholder',
    'stage7jNicknameExample',
    'stage7jChineseIdentifierRejection',
    'stage7jAdminPreviewNotPublished',
    'stage7jWifiOpen',
    'stage7jMobileDataOpen',
    'stage7jIphoneSafariSmoke',
  ]) assert.equal(real[key], 'passed', `${key}必须保持通过`);

  assert.equal(real.stage7jPublicJsonIosDisplay, 'accepted_non_blocking_reader_display_issue');
  assert.equal(real.stage7jTokenizedPreviewUrlStored, false);
  assert.equal(ledger.releasePolicy.stablePromotionAuthorized, false);
  assert.equal(ledger.releasePolicy.stablePromotionPerformed, false);
  assert.equal(ledger.releasePolicy.productionWriteEnablementIncluded, false);
});
