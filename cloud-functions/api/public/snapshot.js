import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleProductionPublicSnapshotRequest } from '../../../src/server/production_read_http_v1.js';

export default async function onRequest(context) {
  return handleProductionPublicSnapshotRequest(resolveCloudFunctionContext(context));
}
