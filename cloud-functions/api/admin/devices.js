import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleAdminDeviceListRequest } from '../../../src/server/device_governance_http_v1.js';

export default async function onRequest(context) {
  return handleAdminDeviceListRequest(resolveCloudFunctionContext(context));
}
