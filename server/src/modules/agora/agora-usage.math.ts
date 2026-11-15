import { getAudioCoefficient, getVideoCoefficient } from '../session/session.types';

export const MONTHLY_STANDARD_SECONDS = 10_000 * 60;
export const SAFETY_STANDARD_SECONDS = 300 * 60;
export const DAY_MS = 86_400_000;
export type UsageTier = 'audio' | 'hd' | 'fullHd' | '2k' | '4k';
export type UsageBuckets = Record<string, number>;
export interface UsageSegment { from: number; to: number; buckets: UsageBuckets; }
export interface LocalUsage { buckets: UsageBuckets; segments: UsageSegment[]; }
export interface UsageBaseline { at: number; remainingStandardMinutes: number; source: 'manual' | 'monthly_reset'; }
export type UsageBaselines = Record<string, UsageBaseline>;
export const TIERS: UsageTier[] = ['audio', 'hd', 'fullHd', '2k', '4k'];
const QUALITY_TIERS: Record<string, UsageTier> = {
  '480p_2': 'hd', '720p30': 'hd', '1080p_2': 'fullHd', '1080p60': 'fullHd',
  '1440p30': '2k', '1440p60': '2k', '4k30': '4k',
};
const BILLING_TIERS = { hd: 'HD 高清', fullHd: 'Full HD 全高清', '2k': '2K', '4k': '2K+ 超高清' };

export function qualityTier(quality: string): UsageTier { return QUALITY_TIERS[quality] || 'fullHd'; }
export function usageCoefficient(key: string): number {
  const [tier, mode] = key.split('/');
  return tier === 'audio' ? getAudioCoefficient(mode === 'rtc', mode === 'publisher')
    : getVideoCoefficient(BILLING_TIERS[tier], mode === 'rtc');
}
export function standardSeconds(buckets: UsageBuckets): number {
  return Object.entries(buckets).reduce((sum, [key, seconds]) => sum + seconds * usageCoefficient(key), 0);
}
export function monthKey(at: number): string { return new Date(at + 8 * 3600_000).toISOString().slice(0, 7); }
export function monthBounds(month: string): [number, number] {
  const [year, m] = month.split('-').map(Number);
  return [Date.UTC(year, m - 1, 1) - 8 * 3600_000, Date.UTC(year, m, 1) - 8 * 3600_000];
}
export function utcDate(at: number): string { return new Date(at).toISOString().slice(0, 10); }
export function hkDate(at: number): string { return utcDate(at + 8 * 3600_000); }
export function localUsage(value: string): LocalUsage {
  return value ? JSON.parse(value) : { buckets: {}, segments: [] };
}
export function addBuckets(target: UsageBuckets, source: UsageBuckets, factor = 1): void {
  for (const [key, seconds] of Object.entries(source)) target[key] = (target[key] || 0) + seconds * factor;
}
export function segmentSeconds(segment: UsageSegment, from: number, to: number): number {
  const overlap = Math.max(0, Math.min(to, segment.to) - Math.max(from, segment.from));
  return overlap && segment.to > segment.from ? standardSeconds(segment.buckets) * overlap / (segment.to - segment.from) : 0;
}
export function calibrationRange(month: string, baseline: UsageBaseline, now: number): [string, string] | null {
  const [start, end] = monthBounds(month);
  const from = Math.ceil(Math.max(start, baseline.at) / DAY_MS) * DAY_MS;
  const last = Math.min(Math.floor(now / DAY_MS) * DAY_MS - 2 * DAY_MS, Math.floor(end / DAY_MS) * DAY_MS - DAY_MS);
  return from <= last ? [utcDate(from), utcDate(last)] : null;
}

export class AgoraApiError extends Error {
  constructor(public code: string, public retryable = false, public retryAfterMs = 0) { super(code); }
}

export async function agoraGet(path: string, customerId: string, customerSecret: string) {
  try {
    const response = await fetch('https://api.agora.io' + path, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${customerId}:${customerSecret}`).toString('base64') },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      const retryMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
        : Math.max(0, Date.parse(retryAfter || '') - Date.now()) || 0;
      throw new AgoraApiError(`api_http_${response.status}`, response.status === 429 || response.status >= 500, retryMs);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof AgoraApiError) throw error;
    if (error instanceof SyntaxError) throw new AgoraApiError('api_schema');
    throw new AgoraApiError((error as Error)?.name === 'TimeoutError' ? 'api_timeout' : 'api_network', true);
  }
}

const API_FIELDS: Record<UsageTier, string> = {
  audio: 'durationAudioAll', hd: 'durationVideoHd', fullHd: 'durationVideo1080P', '2k': 'durationVideo2K', '4k': 'durationVideo4K',
};
/** HDP is an aggregate of the independent Full HD/2K/2K+ buckets, not another charge. */
export function parseOfficialUsage(body: any, from: string, to: string): Map<string, Record<UsageTier, number>> {
  if (!Array.isArray(body?.usages)) throw new AgoraApiError('api_schema');
  const result = new Map<string, Record<UsageTier, number>>();
  for (const row of body.usages) {
    const at = typeof row.date === 'number' ? (row.date < 1e12 ? row.date * 1000 : row.date) : Date.parse(row.date);
    if (!Number.isFinite(at) || at % DAY_MS !== 0) throw new AgoraApiError('api_schema');
    const date = utcDate(at);
    if (date < from || date > to || result.has(date)) throw new AgoraApiError('api_schema');
    const buckets = {} as Record<UsageTier, number>;
    for (const tier of TIERS) {
      const field = API_FIELDS[tier], unit = body.meta?.[field]?.unit;
      const seconds = row.usage?.[field];
      if (!['second', 'seconds'].includes(unit) || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new AgoraApiError('api_schema');
      buckets[tier] = seconds;
    }
    const hdp = row.usage?.durationVideoHdp;
    if (hdp !== undefined && (typeof hdp !== 'number' || !Number.isFinite(hdp) || Math.abs(hdp - buckets.fullHd - buckets['2k'] - buckets['4k']) > 1)) {
      throw new AgoraApiError('api_hdp_overlap_unknown');
    }
    result.set(date, buckets);
  }
  for (let at = Date.parse(from); at <= Date.parse(to); at += DAY_MS) {
    if (!result.has(utcDate(at))) throw new AgoraApiError('api_incomplete_dates', true);
  }
  return result;
}

export function calibrateUsage(official: Record<UsageTier, number>, local: UsageBuckets) {
  let seconds = 0, unknownMode = false;
  for (const tier of TIERS) {
    const entries = Object.entries(local).filter(([key]) => key.startsWith(tier + '/'));
    const raw = entries.reduce((sum, [, value]) => sum + value, 0);
    const coefficient = raw > 0 ? entries.reduce((sum, [key, value]) => sum + value * usageCoefficient(key), 0) / raw : usageCoefficient(tier + '/rtc');
    if (official[tier] > 0 && raw === 0) unknownMode = true;
    seconds += official[tier] * coefficient;
  }
  return { seconds, unknownMode };
}
