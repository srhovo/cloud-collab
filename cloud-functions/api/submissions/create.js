import { acceptSubmission } from '../../../src/server/submission_acceptance_v1.js';
import { MAX_SUBMISSION_BYTES } from '../../../src/server/submission_policy_v1.js';
import {
  assertPreviewSubmissionScope,
  methodNotAllowed,
  optionsResponse,
  readJsonBody,
  requirePreviewWriteAccess,
  resolvePreviewBlobStore,
  responseForError,
  success,
} from '../_shared/preview-write-http.js';

const SERVICE_ID = 'cloud-collab-preview-submission';

export default async function onRequest(context) {
  const method = String(context?.request?.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'POST') return methodNotAllowed(SERVICE_ID, method);

  try {
    requirePreviewWriteAccess(context);
    const body = await readJsonBody(context.request, { maxBytes: MAX_SUBMISSION_BYTES });
    assertPreviewSubmissionScope(body.value);
    const store = resolvePreviewBlobStore(context);

    const result = await acceptSubmission({
      store,
      authorization: context.request.headers.get('authorization'),
      rawSubmission: body.value,
    });

    return success(SERVICE_ID, {
      ...result,
      environment: 'isolated_preview',
      fixtureScopeOnly: true,
      publicMutationAllowed: false,
      autoApprovalEnabled: false,
    }, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    return responseForError(SERVICE_ID, error);
  }
}
