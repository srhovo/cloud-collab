import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_ORDINARY_REVIEW_MUTATION_CAPABILITIES,
  isAdminOrdinaryReviewMutationProjectionSafe,
} from '../src/server/admin_ordinary_review_mutation_v1.js';
import {
  handleAdminOrdinaryReviewApproveRequest,
  handleAdminOrdinaryReviewEditAndApproveRequest,
  handleAdminOrdinaryReviewRejectRequest,
} from '../src/server/admin_ordinary_review_mutation_http_v1.js';
import {
  ENV,
  NOW,
  request,
  seedNewBossConflict,
} from './stage5g-admin-ordinary-fixtures.mjs';

test('Stage5G ordinary mutation HTTP requires same-origin admin session and strict JSON', async () => {
  const { store, queue } = await seedNewBossConflict();
  const reviewId = queue.items[0].reviewId;
  const dependencies = { now: () => NOW + 2000, createStore: () => store };

  const denied = await handleAdminOrdinaryReviewApproveRequest({
    env: ENV,
    request: request('/api/admin/ordinary-reviews/approve', {
      cookie: null,
      body: { reviewId, confirmation: 'APPROVE_ORDINARY' },
    }),
  }, dependencies);
  assert.equal(denied.status, 401);

  const crossOrigin = await handleAdminOrdinaryReviewApproveRequest({
    env: ENV,
    request: request('/api/admin/ordinary-reviews/approve', {
      origin: 'https://attacker.example',
      body: { reviewId, confirmation: 'APPROVE_ORDINARY' },
    }),
  }, dependencies);
  assert.equal(crossOrigin.status, 403);

  const wrongType = await handleAdminOrdinaryReviewRejectRequest({
    env: ENV,
    request: request('/api/admin/ordinary-reviews/reject', {
      contentType: 'text/plain',
      body: '{}',
    }),
  }, dependencies);
  assert.equal(wrongType.status, 415);

  const response = await handleAdminOrdinaryReviewApproveRequest({
    env: ENV,
    request: request('/api/admin/ordinary-reviews/approve', {
      body: { reviewId, confirmation: 'APPROVE_ORDINARY' },
    }),
  }, dependencies);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.result.status, 'approved_by_admin');
  assert.deepEqual(payload.data.capabilities, ADMIN_ORDINARY_REVIEW_MUTATION_CAPABILITIES);
  assert.equal(isAdminOrdinaryReviewMutationProjectionSafe(payload.data), true);

  const get = await handleAdminOrdinaryReviewEditAndApproveRequest({
    env: ENV,
    request: request('/api/admin/ordinary-reviews/edit-and-approve', { method: 'GET' }),
  }, dependencies);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
});
