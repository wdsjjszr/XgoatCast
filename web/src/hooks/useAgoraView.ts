import { useCallback, useEffect, useRef, useState } from 'react';
import type { IAgoraRTCClient, IRemoteVideoTrack, IRemoteAudioTrack } from 'agora-rtc-sdk-ng';
import { api } from '../lib/api';
import { createRtcLog, installRtcTokenRenewal, rtcErrorCode } from '../lib/rtcLifecycle';

export interface ViewerState {
  joined: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
  audioBlocked: boolean;
  error: string;
}
const INITIAL_STATE: ViewerState = { joined: false, hasVideo: false, hasAudio: false, audioBlocked: false, error: '' };

export function useAgoraView(token: string, active: boolean, lowLatency: boolean, audioPreferences = { volume: 100, muted: false }) {
  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const videoRef = useRef<IRemoteVideoTrack | null>(null);
  const audioRef = useRef<IRemoteAudioTrack | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const leavingRef = useRef<Promise<void>>(Promise.resolve());
  const identityRef = useRef<{ token: string; uid: number } | null>(null);
  const volumeRef = useRef(audioPreferences.volume);
  const mutedRef = useRef(audioPreferences.muted);
  const audioBlockedRef = useRef(false);
  const [state, setState] = useState<ViewerState>(INITIAL_STATE);

  const setPlayerContainer = useCallback((el: HTMLDivElement | null) => {
    playerContainerRef.current = el;
    if (el) videoRef.current?.play(el, { fit: 'contain' });
  }, []);

  const applyVolume = useCallback(() => {
    audioRef.current?.setVolume(mutedRef.current || audioBlockedRef.current ? 0 : volumeRef.current);
  }, []);

  useEffect(() => {
    const AgoraRTC = (window as any).AgoraRTC;
    if (!AgoraRTC) return;
    const handleAutoplayFailed = () => {
      if (!audioRef.current) return;
      audioBlockedRef.current = true;
      applyVolume();
      setState((s) => ({ ...s, audioBlocked: true }));
    };
    AgoraRTC.onAutoplayFailed = handleAutoplayFailed;
    return () => {
      if (AgoraRTC.onAutoplayFailed === handleAutoplayFailed) AgoraRTC.onAutoplayFailed = undefined;
    };
  }, [applyVolume]);

  useEffect(() => {
    setState({ ...INITIAL_STATE, audioBlocked: audioBlockedRef.current });
    if (!active) return;
    const AgoraRTC = (window as any).AgoraRTC;
    const log = createRtcLog(token, 'subscriber', AgoraRTC?.VERSION);
    const abort = new AbortController();
    let cancelled = false;
    let client: IAgoraRTCClient | null = null;
    let renewal: ReturnType<typeof installRtcTokenRenewal> | undefined;
    let failedLeave: Promise<void> = Promise.resolve();
    let uid: number | undefined;
    let epoch = 0;
    const mediaEpoch = { video: 0, audio: 0 };
    const subscribing = new Set<string>();
    const errors = { video: '', audio: '' };
    const current = () => !cancelled && clientRef.current === client;
    const resetPlayback = () => {
      epoch++;
      subscribing.clear();
      try { videoRef.current?.stop(); } catch {}
      try { audioRef.current?.stop(); } catch {}
      videoRef.current = null;
      audioRef.current = null;
      errors.video = errors.audio = '';
      setState(s => ({ ...s, joined: false, hasVideo: false, hasAudio: false, error: '' }));
    };
    const previousLeave = leavingRef.current;
    const join = async () => {
      try {
        await previousLeave;
        if (cancelled) return;
        if (!AgoraRTC) throw Object.assign(new Error('Agora SDK 未加载，请刷新后重试'), { code: 'RTC_SDK_UNAVAILABLE' });
        AgoraRTC.setLogLevel(2);
        const credentials = await api.getShareToken(token, 'subscriber', identityRef.current?.token === token ? identityRef.current.uid : undefined, abort.signal);
        if (cancelled) return;
        uid = credentials.uid;
        identityRef.current = { token, uid: credentials.uid };
        client = AgoraRTC.createClient({ mode: lowLatency ? 'rtc' : 'live', codec: 'h264' });
        clientRef.current = client;
        if (!lowLatency) {
          await client.setClientRole('audience', { level: 1 });
          if (!current()) return;
        }

        client.on('connection-state-change', (state, _previous, reason) => {
          if (current()) log('connection_change', { uid, state, reason });
        });
        client.on('user-published', async (user, mediaType) => {
          if (!current() || (mediaType !== 'video' && mediaType !== 'audio')) return;
          const version = epoch;
          const mediaVersion = mediaEpoch[mediaType];
          const key = `${version}:${mediaVersion}:${user.uid}:${mediaType}`;
          if (subscribing.has(key)) return;
          if (mediaType === 'video' ? videoRef.current && videoRef.current === user.videoTrack : audioRef.current && audioRef.current === user.audioTrack) return;
          subscribing.add(key);
          try {
            await client!.subscribe(user, mediaType);
            if (!current() || epoch !== version || mediaEpoch[mediaType] !== mediaVersion || !(mediaType === 'video' ? user.hasVideo : user.hasAudio)) return;
            if (mediaType === 'video') {
              videoRef.current = user.videoTrack!;
              if (playerContainerRef.current) videoRef.current.play(playerContainerRef.current, { fit: 'contain' });
            } else {
              audioRef.current = user.audioTrack!;
              applyVolume();
              audioRef.current.play();
            }
            errors[mediaType] = '';
            log('subscribe_success', { uid, mediaType });
            setState(s => ({ ...s, [mediaType === 'video' ? 'hasVideo' : 'hasAudio']: true, error: errors.video || errors.audio }));
          } catch (error) {
            if (!current() || epoch !== version || mediaEpoch[mediaType] !== mediaVersion) return;
            log('subscribe_failed', { uid, mediaType, errorCode: rtcErrorCode(error) });
            errors[mediaType] = mediaType === 'video' ? '画面订阅失败，请刷新页面重试。' : '声音订阅失败，请刷新页面重试。';
            setState(s => ({ ...s, error: errors.video || errors.audio }));
          } finally {
            subscribing.delete(key);
          }
        });
        client.on('user-unpublished', (user, mediaType) => {
          if (!current() || (mediaType !== 'video' && mediaType !== 'audio')) return;
          mediaEpoch[mediaType]++;
          if (mediaType === 'video') { try { user.videoTrack?.stop(); } catch {} videoRef.current = null; }
          else { try { user.audioTrack?.stop(); } catch {} audioRef.current = null; }
          errors[mediaType] = '';
          log('unsubscribe', { uid, mediaType });
          setState(s => ({ ...s, [mediaType === 'video' ? 'hasVideo' : 'hasAudio']: false, error: errors.video || errors.audio }));
        });
        client.on('user-left', (user, reason) => {
          if (!current() || user.uid !== 1) return;
          log('remote_left', { uid, reason });
          resetPlayback();
          setState(s => ({ ...s, joined: true }));
        });
        renewal = installRtcTokenRenewal({
          client, token, role: 'subscriber', identity: credentials, isCurrent: current, log,
          beforeRejoin: resetPlayback,
          // The SDK emits user-published for existing publications on rejoin.
          afterRejoin: async () => { setState(s => ({ ...s, joined: true, error: '' })); },
          onError: () => {
            resetPlayback();
            setState(s => ({ ...s, error: '观看连接续期失败，请刷新页面重试。' }));
            cancelled = true;
            client!.removeAllListeners();
            void renewal?.dispose();
            failedLeave = client!.leave().then(() => log('rtc_leave', { uid, reason: 'TOKEN_RECOVERY' })).catch(error => {
              log('rtc_leave', { uid, reason: 'TOKEN_RECOVERY', errorCode: rtcErrorCode(error) });
            });
          },
        });
        log('join_start', { uid });
        await client.join(credentials.appId, credentials.channel, credentials.token || null, uid);
        if (!current()) return;
        log('join_success', { uid });
        setState(s => ({ ...s, joined: true }));
      } catch (error) {
        if (cancelled) return;
        log('join_failed', { uid, errorCode: rtcErrorCode(error) });
        setState(s => ({ ...s, error: '无法连接共享，请检查网络后刷新重试。' }));
        cancelled = true;
        await renewal?.dispose();
        client?.removeAllListeners();
        try { await client?.leave(); } catch {}
      }
    };
    const joining = join();
    return () => {
      cancelled = true;
      abort.abort();
      const renewing = renewal?.dispose();
      client?.removeAllListeners();
      if (clientRef.current === client) {
        resetPlayback();
        clientRef.current = null;
      }
      leavingRef.current = (async () => {
        await joining;
        await renewing;
        await failedLeave;
        try { await client?.leave(); } catch {}
        if (client) log('rtc_leave', { uid, reason: 'CLEANUP' });
      })();
    };
  }, [token, active, lowLatency, applyVolume]);

  const setAudioMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted;
    if (!muted) {
      audioBlockedRef.current = false;
      audioRef.current?.play();
      setState(s => ({ ...s, audioBlocked: audioBlockedRef.current }));
    }
    applyVolume();
  }, [applyVolume]);

  const setVolume = useCallback((level: number) => {
    volumeRef.current = Math.max(0, Math.min(100, level));
    applyVolume();
  }, [applyVolume]);

  return { ...state, setPlayerContainer, setAudioMuted, setVolume };
}
