import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleProductionPublicVersionRequest } from '../../../src/server/production_read_http_v1.js';

export default async function onRequest(context) {
  return handleProductionPublicVersionRequest(resolveCloudFunctionContext(context));
}
