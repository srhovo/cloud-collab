import { registerDevice } from '../../../src/server/device_registration_v1.js';
import {
  methodNotAllowed,
  optionsResponse,
  readJsonBody,
  requirePreviewWriteAccess,
  resolvePreviewBlobStore,
  responseForError,
  success,
} from '../_shared/preview-write-http.js';

const SERVICE_ID = 'cloud-collab-preview-device-registration';
const MAX_DEVICE_REGISTER_BYTES = 8 * 1024;

export default async function onRequest(context) {
  const method = String(context?.request?.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'POST') return methodNotAllowed(SERVICE_ID, method);

  try {
    requirePreviewWriteAccess(context);
    const store = resolvePreviewBlobStore(context);
    const body = await readJsonBody(context.request, { maxBytes: MAX_DEVICE_REGISTER_BYTES });
    const credential = await registerDevice({ store, input: body.value });

    return success(SERVICE_ID, {
      status: 'registered',
      environment: 'isolated_preview',
      device: {
        schemaVersion: credential.schemaVersion,
        deviceId: credential.deviceId,
        nicknameTag: credential.nicknameTag,
        tokenVersion: credential.tokenVersion,
        issuedAt: credential.issuedAt,
        expiresAt: credential.expiresAt,
      },
      credential: {
        deviceToken: credential.deviceToken,
        tokenVersion: credential.tokenVersion,
        issuedAt: credential.issuedAt,
        expiresAt: credential.expiresAt,
      },
      submissionEnabled: false,
      publicMutationAllowed: false,
      autoApprovalEnabled: false,
    }, { status: 201 });
  } catch (error) {
    return responseForError(SERVICE_ID, error);
  }
}
