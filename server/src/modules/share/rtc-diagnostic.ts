const EVENTS = new Set([
  'join_start', 'join_success', 'join_failed', 'connection_change',
  'token_will_expire', 'token_expired', 'token_renewed', 'token_renew_failed',
  'token_rejoin_success', 'publish_success', 'publish_failed', 'unpublish',
  'subscribe_success', 'subscribe_failed', 'unsubscribe', 'remote_left',
  'capture_ended', 'rtc_leave',
]);
const STATES = new Set(['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'RECONNECTING', 'DISCONNECTING']);
const REASONS = new Set([
  'LEAVE', 'NETWORK_ERROR', 'SERVER_ERROR', 'UID_BANNED', 'IP_BANNED', 'TOKEN_EXPIRE',
  'FALLBACK', 'PROXY_SERVER_NOT_FOUND', 'PROXY_SERVER_NOT_SUPPORTED', 'JOIN_FAILED',
  'CLIENT_LEAVE', 'REMOTE_OFFLINE', 'CLIENT_BANNED', 'CAPTURE_ENDED', 'STOP', 'CLEANUP',
  'TOKEN_RECOVERY', 'MICROPHONE',
  'Quit', 'ServerTimeOut', 'BecomeAudience',
  'CHANNEL_BANNED', 'LICENSE_MISSING', 'LICENSE_EXPIRED', 'LICENSE_MINUTES_EXCEEDED',
  'LICENSE_PERIOD_INVALID', 'LICENSE_MULTIPLE_SDK_SERVICE', 'LICENSE_ILLEGAL', 'FALLBACK_TO_HLS', 'UID_CONFLICT',
]);
const ERROR_CODES = new Set([
  'NETWORK_ERROR', 'NETWORK_TIMEOUT', 'NETWORK_RESPONSE_ERROR', 'INVALID_TOKEN', 'TOKEN_EXPIRED',
  'CAN_NOT_GET_GATEWAY_SERVER', 'GATEWAY_SERVER_ERROR', 'UID_CONFLICT', 'INVALID_OPERATION',
  'NOT_SUPPORTED', 'PERMISSION_DENIED', 'WEB_SECURITY_RESTRICT', 'TRACK_IS_DISABLED',
  'REMOTE_USER_IS_NOT_PUBLISHED', 'SUBSCRIBE_FAILED', 'PUBLISH_FAILED', 'UNEXPECTED_ERROR',
  'RTC_IDENTITY_CHANGED', 'RTC_SDK_UNAVAILABLE', 'RTC_ERROR',
]);

/** Pick known scalar fields only: SDK errors and request bodies can contain credentials. */
export function rtcDiagnostic(sessionId: string, body: any) {
  if (!EVENTS.has(body?.event) || !['publisher', 'subscriber'].includes(body?.role)) return null;
  return {
    occurredAt: Date.now(), sessionId, eventType: body.event, role: body.role,
    clientId: typeof body.clientId === 'string' && /^[0-9a-f-]{36}$/i.test(body.clientId) ? body.clientId : undefined,
    uid: Number.isInteger(body.uid) && body.uid > 0 && body.uid <= 0xffffffff ? body.uid : undefined,
    sdkVersion: typeof body.sdkVersion === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(body.sdkVersion) ? body.sdkVersion : undefined,
    mediaType: ['video', 'audio'].includes(body.mediaType) ? body.mediaType : undefined,
    state: STATES.has(body.state) ? body.state : undefined,
    reason: REASONS.has(body.reason) ? body.reason : undefined,
    errorCode: ERROR_CODES.has(body.errorCode) ? body.errorCode : undefined,
  };
}
