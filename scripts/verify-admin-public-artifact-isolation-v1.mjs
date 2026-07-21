import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminDir = path.join(root, '.edgeone-admin-artifact');
const publicDir = path.join(root, '.edgeone-artifact');

function fail(code, details = null) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

function list(directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail('ARTIFACT_DIRECTORY_MISSING', { directory });
  }
  return fs.readdirSync(directory).sort();
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const adminFiles = list(adminDir);
const publicFiles = list(publicDir);
if (!same(adminFiles, ['admin-release.json', 'index.html'])) {
  fail('ADMIN_ARTIFACT_FILES_INVALID', { adminFiles });
}
if (!same(publicFiles, ['build-manifest.json', 'index.html', 'pages-release.json'])) {
  fail('PUBLIC_ARTIFACT_FILES_INVALID', { publicFiles });
}

for (const [directory, filenames] of [[adminDir, adminFiles], [publicDir, publicFiles]]) {
  for (const filename of filenames) {
    const stat = fs.lstatSync(path.join(directory, filename));
    if (!stat.isFile() || stat.isSymbolicLink()) fail('ARTIFACT_FILE_TYPE_INVALID', { directory, filename });
  }
}

const source = fs.readFileSync(path.join(root, 'dist', 'admin-production-console.html'));
const adminIndex = fs.readFileSync(path.join(adminDir, 'index.html'));
const publicIndex = fs.readFileSync(path.join(publicDir, 'index.html'));
if (!source.equals(adminIndex)) fail('ADMIN_SOURCE_MISMATCH');
if (source.equals(publicIndex)) fail('ADMIN_PUBLIC_INDEX_COLLISION');

const release = JSON.parse(fs.readFileSync(path.join(adminDir, 'admin-release.json'), 'utf8'));
if (release.kind !== 'production_admin_console_artifact'
    || release.includesOrdinaryUserCandidate !== false
    || release.includesSecretValues !== false
    || release.productionCapabilitiesDefaultOff !== true
    || release.stablePromotionAuthorized !== false
    || release.stablePromotionPerformed !== false
    || release.productionWriteEnablementIncluded !== false) {
  fail('ADMIN_RELEASE_BOUNDARY_INVALID');
}

process.stdout.write(`${JSON.stringify({
  verified: true,
  adminFiles,
  publicFiles,
  adminBytes: adminIndex.length,
  publicBytes: publicIndex.length,
  mutuallyExclusive: true,
  stablePromotionAuthorized: false,
})}\n`);
