import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminExportDownloadRequest } from '../../../../src/server/admin_export_http_v1.js';

export default async function onRequest(context) {
  return handleAdminExportDownloadRequest(resolveCloudFunctionContext(context));
}
