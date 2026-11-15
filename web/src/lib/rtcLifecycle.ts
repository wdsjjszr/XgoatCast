import type { IAgoraRTCClient } from 'agora-rtc-sdk-ng';
import type { AgoraTokenResponse } from '../types';
import { api, ApiError } from './api';

export type RtcEvent = 'join_start' | 'join_success' | 'join_failed' | 'connection_change' |
  'token_will_expire' | 'token_expired' | 'token_renewed' | 'token_renew_failed' |
  'token_rejoin_success' | 'publish_success' | 'publish_failed' | 'unpublish' |
  'subscribe_success' | 'subscribe_failed' | 'unsubscribe' | 'remote_left' |
  'capture_ended' | 'rtc_leave';
interface DiagnosticFields {
  uid?: number;
  mediaType?: 'video' | 'audio';
  state?: string;
  reason?: string;
  errorCode?: string;
}
export interface RtcDiagnosticPayload extends DiagnosticFields {
  token: string;
  eventType: 'rtc_diagnostic';
  event: RtcEvent;
  role: 'publisher' | 'subscriber';
  clientId: string;
  sdkVersion?: string;
}
export type RtcLog = (event: RtcEvent, fields?: DiagnosticFields) => void;

const ERROR_CODES = new Set([
  'NETWORK_ERROR', 'NETWORK_TIMEOUT', 'NETWORK_RESPONSE_ERROR', 'INVALID_TOKEN', 'TOKEN_EXPIRED',
  'CAN_NOT_GET_GATEWAY_SERVER', 'GATEWAY_SERVER_ERROR', 'UID_CONFLICT', 'INVALID_OPERATION',
  'NOT_SUPPORTED', 'PERMISSION_DENIED', 'WEB_SECURITY_RESTRICT', 'TRACK_IS_DISABLED',
  'REMOTE_USER_IS_NOT_PUBLISHED', 'SUBSCRIBE_FAILED', 'PUBLISH_FAILED', 'UNEXPECTED_ERROR',
  'RTC_IDENTITY_CHANGED', 'RTC_SDK_UNAVAILABLE', 'RTC_ERROR',
]);

export function rtcErrorCode(error: unknown): string {
  const code = (error as { code?: string })?.code;
  return ERROR_CODES.has(code) ? code! : 'RTC_ERROR';
}

export function createRtcLog(token: string, role: 'publisher' | 'subscriber', sdkVersion?: string): RtcLog {
  const clientId = crypto.randomUUID();
  return (event, fields = {}) => {
    const diagnostic = { eventType: 'rtc_diagnostic' as const, event, role, clientId, sdkVersion, ...fields };
    // Never log the authentication token or SDK error objects (which can embed RTC tokens).
    console.info('[RTC]', diagnostic);
    void api.reportShareTelemetry({ token, ...diagnostic }).catch(() => {});
  };
}

export function installRtcTokenRenewal(options: {
  client: IAgoraRTCClient;
  token: string;
  role: 'publisher' | 'subscriber';
  identity: AgoraTokenResponse;
  isCurrent: () => boolean;
  log: RtcLog;
  beforeRejoin: () => void;
  afterRejoin: () => Promise<void>;
  onError: () => void;
}) {
  const { client, identity, log } = options;
  let disposed = false;
  let expired = false;
  let rejoining = false;
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelDelay: (() => void) | undefined;
  const current = () => !disposed && options.isCurrent();
  const check = () => { if (!current()) throw new Error('RTC operation cancelled'); };

  const retry = async <T,>(operation: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      check();
      try {
        return await operation();
      } catch (error) {
        check();
        const transient = error instanceof TypeError || (error as Error)?.name === 'AbortError' ||
          ['NETWORK_ERROR', 'NETWORK_TIMEOUT', 'NETWORK_RESPONSE_ERROR'].includes((error as { code?: string })?.code || '') ||
          (error instanceof ApiError && ([408, 429].includes(error.statusCode) || error.statusCode >= 500));
        if (!transient || attempt === 2) throw error;
      }
      await new Promise<void>(resolve => {
        cancelDelay = resolve;
        retryTimer = setTimeout(resolve, (attempt + 1) * 1000);
      });
      cancelDelay = undefined;
    }
  };

  const refresh = () => {
    if (!current() || inFlight) return;
    inFlight = (async () => {
      try {
        await retry(async () => {
          controller = new AbortController();
          const timeout = setTimeout(() => controller?.abort(), 10_000);
          let next: AgoraTokenResponse;
          try { next = await api.getShareToken(options.token, options.role, identity.uid, controller.signal); }
          finally { clearTimeout(timeout); }
          check();
          if (next.appId !== identity.appId || next.channel !== identity.channel || next.uid !== identity.uid) {
            throw Object.assign(new Error('RTC identity changed'), { code: 'RTC_IDENTITY_CHANGED' });
          }
          if (!expired) {
            try { await client.renewToken(next.token); }
            catch (error) { if (!expired) throw error; }
            check();
            if (!expired) { log('token_renewed', { uid: identity.uid }); return; }
          }
          rejoining = true;
          options.beforeRejoin();
          await client.leave();
          check();
          if (client.mode === 'live') {
            if (options.role === 'publisher') await client.setClientRole('host');
            else await client.setClientRole('audience', { level: 1 });
            check();
          }
          log('join_start', { uid: identity.uid, reason: 'TOKEN_RECOVERY' });
          try { await client.join(identity.appId, identity.channel, next.token || null, identity.uid); }
          catch (error) { if (current()) log('join_failed', { uid: identity.uid, errorCode: rtcErrorCode(error) }); throw error; }
          check();
          log('join_success', { uid: identity.uid, reason: 'TOKEN_RECOVERY' });
          await options.afterRejoin();
          check();
          expired = false;
          log('token_rejoin_success', { uid: identity.uid });
        });
      } catch (error) {
        if (current()) {
          log('token_renew_failed', { uid: identity.uid, errorCode: rtcErrorCode(error) });
          options.onError();
        }
      } finally {
        rejoining = false;
        inFlight = null;
      }
    })();
  };
  const willExpire = () => {
    if (!current() || rejoining) return;
    log('token_will_expire', { uid: identity.uid });
    refresh();
  };
  const didExpire = () => {
    if (!current() || rejoining) return;
    expired = true;
    log('token_expired', { uid: identity.uid });
    refresh();
  };
  client.on('token-privilege-will-expire', willExpire);
  client.on('token-privilege-did-expire', didExpire);
  return {
    dispose(): Promise<void> {
      disposed = true;
      client.off('token-privilege-will-expire', willExpire);
      client.off('token-privilege-did-expire', didExpire);
      controller?.abort();
      clearTimeout(retryTimer);
      cancelDelay?.();
      return inFlight ?? Promise.resolve();
    },
  };
}
