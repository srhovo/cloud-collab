import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAdminOrdinaryReviewMutationProjectionSafe,
  mutateAdminOrdinaryReview,
  normalizeAdminOrdinaryReviewCommand,
  readAdminOrdinaryReviewMutationConfig,
} from '../src/server/admin_ordinary_review_mutation_v1.js';
import { listAdminOrdinaryReviewQueue } from '../src/server/admin_ordinary_review_projection_v1.js';
import {
  buildOrdinaryPublicSnapshot,
  listValidOrdinaryPublicEvents,
} from '../src/server/ordinary_public_engine_v1.js';
import {
  ENV,
  GROUP,
  IDENTITY,
  LIBRARY,
  NOW,
  keys,
  seedNewBossConflict,
  seedPlayablePublicConflict,
  seedSensitiveBossChange,
} from './stage5g-admin-ordinary-fixtures.mjs';

function command(action, input) {
  return { action, input };
}

test('Stage5G ordinary mutation config is default-off and uses dedicated confirmations', () => {
  assert.throws(
    () => readAdminOrdinaryReviewMutationConfig({ ...ENV, CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '0' }),
    error => error.code === 'ADMIN_ORDINARY_REVIEW_MUTATION_PREVIEW_DISABLED',
  );
  assert.throws(
    () => normalizeAdminOrdinaryReviewCommand('approve', {
      reviewId: `rv_v1_${'A'.repeat(43)}`,
      confirmation: 'APPROVE',
    }),
    error => error.code === 'ADMIN_ORDINARY_REVIEW_CONFIRMATION_REQUIRED',
  );
  assert.throws(
    () => normalizeAdminOrdinaryReviewCommand('reject', {
      reviewId: `rv_v1_${'A'.repeat(43)}`,
      confirmation: 'REJECT_ORDINARY',
      reasonCode: 'free_text',
    }),
    error => error.code === 'ADMIN_ORDINARY_REVIEW_REJECTION_INVALID',
  );
});

test('Stage5G approves one new-boss conflict, archives siblings, and replays idempotently', async () => {
  const { store, config, queue } = await seedNewBossConflict();
  const selected = queue.items.find(item => item.payload.discount === 0.97);
  const input = { reviewId: selected.reviewId, confirmation: 'APPROVE_ORDINARY' };
  const result = await mutateAdminOrdinaryReview({
    store,
    config,
    identity: IDENTITY,
    command: command('approve', input),
    now: NOW + 2000,
  });
  assert.equal(result.status, 'approved_by_admin');
  assert.equal(result.dataType, 'boss_profile');
  assert.equal(result.publicVersion, 1);
  assert.equal(result.resolvedReviewCount, 2);
  assert.equal(result.duplicate, false);
  assert.equal(isAdminOrdinaryReviewMutationProjectionSafe(result), true);
  const events = await listValidOrdinaryPublicEvents({ store, libraryId: LIBRARY });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.discount, 0.97);
  assert.equal(events[0].approval.mode, 'admin_approved');
  assert.equal((await listAdminOrdinaryReviewQueue({ store, config })).total, 0);
  assert.equal(keys(store, 'audit/').length, 1);
  assert.equal(keys(store, `reviews/${LIBRARY}/resolved/`).length, 2);
  const replay = await mutateAdminOrdinaryReview({
    store,
    config,
    identity: IDENTITY,
    command: command('approve', input),
    now: NOW + 9999,
  });
  assert.equal(replay.duplicate, true);
  assert.equal((await listValidOrdinaryPublicEvents({ store, libraryId: LIBRARY })).length, 1);
});

test('Stage5G rejects one ordinary conflict without changing public data', async () => {
  const { store, config, queue } = await seedNewBossConflict();
  const selected = queue.items[0];
  const result = await mutateAdminOrdinaryReview({
    store,
    config,
    identity: IDENTITY,
    command: command('reject', {
      reviewId: selected.reviewId,
      confirmation: 'REJECT_ORDINARY',
      reasonCode: 'conflicting_candidates',
    }),
    now: NOW + 2000,
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.publicVersion, 0);
  assert.equal(result.publicMutationApplied, false);
  assert.equal(result.resolvedReviewCount, 1);
  assert.equal((await listAdminOrdinaryReviewQueue({ store, config })).total, 1);
  assert.equal((await listValidOrdinaryPublicEvents({ store, libraryId: LIBRARY })).length, 0);
});

test('Stage5G edit-and-approve preserves playable identity while publishing a changed casing', async () => {
  const { store, config, queue, initial } = await seedPlayablePublicConflict();
  const selected = queue.items[0];
  const result = await mutateAdminOrdinaryReview({
    store,
    config,
    identity: IDENTITY,
    command: command('edit_and_approve', {
      reviewId: selected.reviewId,
      confirmation: 'EDIT_AND_APPROVE_ORDINARY',
      payload: { name: 'AliCe' },
    }),
    now: NOW + 2000,
  });
  assert.equal(result.status, 'edited_and_approved');
  assert.equal(result.publicVersion, 2);
  const snapshot = await buildOrdinaryPublicSnapshot({ store, groupId: GROUP, libraryId: LIBRARY, now: NOW + 3000 });
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].payload.name, 'AliCe');
  assert.notEqual(snapshot.records[0].contentHash, initial.contentHash);
});

test('Stage5G refuses every mutation for direct-report changes reserved for Stage6', async () => {
  const { store, config, queue } = await seedSensitiveBossChange();
  const reviewId = queue.items[0].reviewId;
  const commands = [
    command('approve', { reviewId, confirmation: 'APPROVE_ORDINARY' }),
    command('reject', { reviewId, confirmation: 'REJECT_ORDINARY', reasonCode: 'unsupported_change' }),
    command('edit_and_approve', {
      reviewId,
      confirmation: 'EDIT_AND_APPROVE_ORDINARY',
      payload: { bossName: '老板乙', paiDan: '直属A', discount: 0.96 },
    }),
  ];
  for (const item of commands) {
    await assert.rejects(
      () => mutateAdminOrdinaryReview({ store, config, identity: IDENTITY, command: item, now: NOW + 2000 }),
      error => error.code === 'ADMIN_ORDINARY_REVIEW_STAGE6_REQUIRED' && error.status === 409,
    );
  }
  const snapshot = await buildOrdinaryPublicSnapshot({ store, groupId: GROUP, libraryId: LIBRARY, now: NOW + 3000 });
  assert.equal(snapshot.publicVersion, 1);
  assert.equal(snapshot.records[0].payload.paiDan, '直属A');
  assert.equal(keys(store, 'audit/').length, 0);
  assert.equal(keys(store, `reviews/${LIBRARY}/resolved/`).length, 0);
});
