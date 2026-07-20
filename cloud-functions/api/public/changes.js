import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleProductionPublicChangesRequest } from '../../../src/server/production_read_http_v1.js';

export default async function onRequest(context) {
  return handleProductionPublicChangesRequest(resolveCloudFunctionContext(context));
}
