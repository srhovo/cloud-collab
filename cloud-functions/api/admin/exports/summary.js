import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import {
  handleAdminExportSummaryByMode as handleAdminExportSummaryRequest,
} from '../../../../src/server/admin_export_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminExportSummaryRequest(resolveCloudFunctionContext(context));
}
