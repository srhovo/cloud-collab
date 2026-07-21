import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
// Stage5F compatibility anchor: admin_export_http_v1
import { handleAdminExportDownloadByMode as handleAdminExportDownloadRequest } from '../../../../src/server/admin_export_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminExportDownloadRequest(resolveCloudFunctionContext(context));
}
