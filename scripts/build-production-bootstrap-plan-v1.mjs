import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertProductionScopeMapping } from '../src/server/production_scope_mapping_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'release', 'production-launch-plan-v1.json'), 'utf8'));
const output = path.join(root, 'dist', 'production-bootstrap-plan-v1.json');

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(Buffer.from(canonicalize(value), 'utf8')).digest('hex');
}

const mapping = assertProductionScopeMapping({
  schemaVersion: plan.scope.mappingVersion,
  external: plan.scope.external,
  protocol: plan.scope.protocol,
});
const { groupId, libraryId } = mapping.protocol;
const initialSnapshot = Object.freeze({
  schemaVersion: 1,
  kind: 'cloud_collab_public_snapshot',
  scope: Object.freeze({ groupId, libraryId }),
  publicVersion: 0,
  records: Object.freeze([]),
  tombstones: Object.freeze([]),
  generatedAt: null,
});

const report = Object.freeze({
  schemaVersion: 1,
  kind: 'production_bootstrap_rehearsal',
  mode: 'dry_run',
  targetStableVersion: plan.stableRelease.targetVersion,
  candidateVersion: plan.candidate.version,
  externalScope: mapping.external,
  protocolScope: mapping.protocol,
  stores: Object.freeze({
    publicData: plan.storage.productionBlobStoreName,
    administratorSecurity: plan.storage.adminBlobStoreName,
  }),
  requiredInitialResources: Object.freeze([
    'group_metadata',
    'library_metadata',
    'public_version_pointer',
    'empty_public_snapshot',
    'submission_queue_namespace',
    'sensitive_review_queue_namespace',
    'immutable_audit_namespace',
    'daily_snapshot_marker',
    'migration_export_marker',
  ]),
  initialSnapshot,
  initialSnapshotSha256: sha256(initialSnapshot),
  oneTimeConfirmation: `INITIALIZE-${mapping.external.clubId}-${mapping.external.libraryId}-V1`,
  realBlobReadsPerformed: 0,
  realBlobWritesPerformed: 0,
  realBlobDeletesPerformed: 0,
  productionFeatureFlagsChanged: 0,
  stablePromotionPerformed: false,
  blockers: Object.freeze([
    'owner_controlled_permanent_domain_required_for_anonymous_public_main_entry',
    'production_blob_stores_must_be_created_in_edgeone_console',
    'independent_random_secrets_must_be_generated_and_configured',
    'bootstrap_must_run_once_with_explicit_confirmation',
    'rollout_must_begin_with_read_sync_only',
  ]),
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
