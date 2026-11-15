import { BadRequestException, ConflictException, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DatabaseService, ServerSession } from '../database/database.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AgoraAccount, AgoraAccountsService } from './agora-accounts.service';
import { EventBusService } from '../events/events.service';
import { addBuckets, agoraGet, AgoraApiError, calibrateUsage, calibrationRange, DAY_MS, hkDate, localUsage, MONTHLY_STANDARD_SECONDS, monthBounds, monthKey, parseOfficialUsage, qualityTier, SAFETY_STANDARD_SECONDS, segmentSeconds, standardSeconds, UsageBuckets, utcDate } from './agora-usage.math';

interface RtcPresence {
  role: 'publisher' | 'subscriber'; presenceId: string; sequence: number;
  online: boolean; video: boolean; seenAt: number;
}
interface Meter { at: number; clients: Map<string, RtcPresence>; }
interface DailyUsage {
  account_id: string; utc_date: string; local_json: string; local_standard_seconds: number;
  official_json: string | null; calibrated_standard_seconds: number | null; calibrated_at: number | null; unknown_mode: number;
}

export interface AgoraBudget {
  agoraAccountLabel?: string;
  remainingStandardMinutes: number | null;
  estimatedRemainingSec: number | null;
  rtcUsageRate: number;
  budgetUpdatedAt: number;
  usageCalibratedAt: number | null;
  budgetEstimateStatus: string;
}

@Injectable()
export class AgoraUsageService implements OnModuleInit {
  private readonly meters = new Map<string, Meter>();
  private readonly syncing = new Set<string>();
  private readonly budgets = new Map<string, AgoraBudget>();
  constructor(private readonly db: DatabaseService, private readonly accounts: AgoraAccountsService, private readonly analytics: AnalyticsService,
    @Optional() private readonly bus?: EventBusService) {}
  private get sql() { return this.db.integrationDatabase; }
  onModuleInit() { void this.runDue(); }
  isSyncing(id: string) { return this.syncing.has(id); }
  attachExisting() { for (const row of this.db.getUnfinishedSessions()) if (row.startedAt) this.touch(row.id); }
  recordTokenIdentity(sessionId: string, appId: string) {
    const row = this.db.getSessionById(sessionId);
    if (row && this.supported(row) && !row.agoraAppId && !row.agoraAccountId) {
      const account = this.accounts.forSpace(row.serverId).find(account => account.app_id === appId.toLowerCase());
      this.db.updateSession(sessionId, { agoraAppId: appId, agoraAccountId: account?.id || null });
    }
  }
  private supported(row: ServerSession) { return this.db.getServer(row.serverId)?.platform === 'heychat'; }

  previewAppId(sessionId: string): string {
    const row = this.db.getSessionById(sessionId), space = row && this.db.getServer(row.serverId);
    if (!row || row.status === 'ended') throw new ConflictException('共享会话已结束');
    if (space?.platform !== 'heychat' || !space.agoraAccountPoolEnabled) return space?.agoraAppId || '';
    const account = this.accounts.forSpace(row.serverId).find(a => a.enabled && a.app_id && a.app_certificate);
    if (!account) throw new ConflictException('本空间账号池没有可用于预览的账号，请联系空间管理员');
    return account.app_id;
  }

  prepareToken(sessionId: string, publisher: boolean): AgoraAccount | undefined {
    this.flush();
    const account = this.sql.transaction(() => {
      const row = this.db.getSessionById(sessionId);
      if (!row || row.status === 'ended') throw new ConflictException('共享会话已结束');
      if (!this.supported(row)) return;
      if (row.agoraAccountId) return this.accounts.spaceAccount(row.serverId, row.agoraAccountId);
      const space = this.db.getServer(row.serverId);
      const accounts = this.accounts.forSpace(row.serverId);
      if (space.agoraAccountPoolEnabled && !row.agoraAppId) {
        if (!publisher) throw new ConflictException('请等待共享者开始共享后再连接');
        const candidates = accounts.filter(a => a.enabled && a.app_certificate && a.customer_id && a.customer_secret && a.project_id)
          .map(account => ({ account, safe: this.balance(account).safeRemainingStandardMinutes }))
          .filter(a => a.safe != null && a.safe > 0)
          .sort((a, b) => b.safe - a.safe || a.account.id.localeCompare(b.account.id));
        const selected = candidates[0]?.account;
        if (!selected) throw new ConflictException('本空间账号池无安全可用账号，请检查启用状态、凭证及余额基准');
        this.db.updateSession(sessionId, { agoraAccountId: selected.id, agoraAppId: selected.app_id });
        return selected;
      }
      const legacy = accounts.find(a => a.app_id === (row.agoraAppId || space.agoraAppId).toLowerCase());
      if (legacy && publisher) this.db.updateSession(sessionId, { agoraAccountId: legacy.id, agoraAppId: legacy.app_id });
      return legacy;
    })();
    this.refreshBudgets();
    return account;
  }

  setPoolEnabled(spaceId: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new BadRequestException('启用状态无效');
    if (enabled) {
      this.flush();
      if (!this.accounts.forSpace(spaceId).some(a => a.enabled && a.app_certificate && a.customer_id && a.customer_secret && a.project_id && this.balance(a).safeRemainingStandardMinutes > 0)) {
        throw new BadRequestException('请先添加并启用至少一个凭证完整且有安全余量的账号');
      }
    }
    this.db.updateServer(spaceId, { agoraAccountPoolEnabled: enabled ? 1 : 0 });
    return { ok: true };
  }

  budget(sessionId: string): AgoraBudget | undefined {
    const row = this.db.getSessionById(sessionId);
    if (!row?.agoraAccountId || !this.supported(row)) return;
    const budget = this.budgets.get(row.agoraAccountId);
    if (!budget) return;
    return { ...budget, agoraAccountLabel: this.accounts.spaceAccount(row.serverId, row.agoraAccountId).label };
  }

  refreshBudgets(now = Date.now()) {
    this.flush();
    const rows = this.db.getUnfinishedSessions().filter(row => this.supported(row) && row.agoraAccountId);
    const rates = new Map<string, number>();
    for (const row of rows) {
      const buckets: UsageBuckets = {};
      for (const client of this.meters.get(row.id)?.clients.values() || []) {
        if (!client.online || client.seenAt + 45_000 <= now) continue;
        const key = client.role === 'publisher' ? 'audio/publisher' : `${client.video ? qualityTier(row.quality) : 'audio'}/${row.lowLatency ? 'rtc' : 'live'}`;
        buckets[key] = (buckets[key] || 0) + 1;
      }
      rates.set(row.agoraAccountId, (rates.get(row.agoraAccountId) || 0) + standardSeconds(buckets));
    }
    this.budgets.clear();
    for (const [id, rate] of rates) {
      const balance = this.balance(this.accounts.get(id), now), remaining = balance.safeRemainingStandardMinutes;
      this.budgets.set(id, { remainingStandardMinutes: remaining, estimatedRemainingSec: remaining == null || rate === 0 ? null : Math.floor(remaining * 60 / rate),
        rtcUsageRate: rate, budgetUpdatedAt: now, usageCalibratedAt: balance.usageCalibratedAt, budgetEstimateStatus: balance.estimateStatus });
    }
    for (const row of rows) this.bus?.emitSessionStateChanged({ sessionId: row.id, status: row.status, viewerCount: row.viewerCount });
  }

  touch(sessionId: string, now = Date.now()): Meter | undefined {
    const row = this.db.getSessionById(sessionId);
    if (!row || row.status === 'ended' || !this.supported(row)) return;
    if (!row.agoraAccountId && (!this.db.getServer(row.serverId)?.agoraAccountPoolEnabled || row.agoraAppId)) {
      const appId = row.agoraAppId || this.db.getServer(row.serverId)?.agoraAppId || '';
      const account = this.accounts.forSpace(row.serverId).find(account => account.app_id === appId.toLowerCase());
      if (account) this.db.updateSession(sessionId, { agoraAccountId: account.id, agoraAppId: appId });
    }
    if (row.rtcStandardSeconds == null) {
      const duration = row.startedAt ? Math.max(0, now - row.startedAt) : 0;
      const buckets = { 'audio/publisher': duration / 1000, [`${qualityTier(row.quality)}/${row.lowLatency ? 'rtc' : 'live'}`]: row.peakViewers * duration / 1000 };
      this.db.updateSession(sessionId, { rtcStandardSeconds: standardSeconds(buckets), viewerDurationMs: row.peakViewers * duration,
        usageEstimateStatus: duration ? 'legacy_and_local_estimate' : 'local_estimate', usageCheckpointAt: now });
    }
    let meter = this.meters.get(sessionId);
    if (!meter) { meter = { at: now, clients: new Map() }; this.meters.set(sessionId, meter); }
    return meter;
  }

  settle(sessionId: string, now = Date.now()) {
    const meter = this.meters.get(sessionId), row = this.db.getSessionById(sessionId);
    if (!meter || !row || row.status === 'ended' || now <= meter.at) return;
    this.sql.transaction(() => {
      let total = 0;
      for (let from = meter.at; from < now;) {
        let to = Math.min(now, (Math.floor(from / DAY_MS) + 1) * DAY_MS);
        for (const client of meter.clients.values()) if (client.online && client.seenAt + 45_000 > from) to = Math.min(to, client.seenAt + 45_000);
        const buckets: UsageBuckets = {};
        for (const client of meter.clients.values()) {
          if (!client.online || client.seenAt + 45_000 <= from) continue;
          const key = client.role === 'publisher' ? 'audio/publisher' : `${client.video ? qualityTier(row.quality) : 'audio'}/${row.lowLatency ? 'rtc' : 'live'}`;
          buckets[key] = (buckets[key] || 0) + (to - from) / 1000;
        }
        const amount = standardSeconds(buckets);
        total += amount;
        if (row.agoraAccountId && amount > 0) {
          const date = utcDate(from);
          const daily = this.sql.prepare('SELECT * FROM agora_usage_daily WHERE account_id=? AND utc_date=?').get(row.agoraAccountId, date) as DailyUsage;
          const local = localUsage(daily?.local_json || '');
          addBuckets(local.buckets, buckets);
          // shortcut: Small personal ledgers keep daily checkpoint segments in JSON; use a segment table if daily blobs become large.
          local.segments.push({ from, to, buckets });
          this.sql.prepare(`INSERT INTO agora_usage_daily(account_id,utc_date,local_json,local_standard_seconds) VALUES(?,?,?,?)
            ON CONFLICT(account_id,utc_date) DO UPDATE SET local_json=excluded.local_json,local_standard_seconds=agora_usage_daily.local_standard_seconds+excluded.local_standard_seconds`).run(row.agoraAccountId, date, JSON.stringify(local), amount);
        }
        from = to;
      }
      this.db.updateSession(sessionId, { rtcStandardSeconds: (row.rtcStandardSeconds || 0) + total,
        viewerDurationMs: (row.viewerDurationMs || 0) + (row.status === 'active' ? row.viewerCount * (now - meter.at) : 0), usageCheckpointAt: now });
    })();
    meter.at = now;
  }

  report(sessionId: string, body: any) {
    if (typeof body?.clientId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.clientId) ||
        typeof body.presenceId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.presenceId) ||
        !['publisher', 'subscriber'].includes(body.role) || !Number.isSafeInteger(body.sequence) || body.sequence < 1 ||
        !Number.isInteger(body.uid) || body.uid < 1 || body.uid > 0xffffffff || (body.role === 'publisher' ? body.uid !== 1 : body.uid === 1) ||
        typeof body.online !== 'boolean' || typeof body.video !== 'boolean') return;
    const row = this.db.getSessionById(sessionId);
    if (!row || row.status === 'ended' || (body.role === 'publisher' && row.publisherClientId && row.publisherClientId !== body.presenceId)) return;
    const meter = this.touch(sessionId);
    if (!meter) return;
    const existing = meter.clients.get(body.clientId);
    if (existing && (body.sequence <= existing.sequence || body.role !== existing.role || body.presenceId !== existing.presenceId)) return;
    if (!existing && meter.clients.size >= 2000) return;
    this.settle(sessionId);
    meter.clients.set(body.clientId, { role: body.role, presenceId: body.presenceId, sequence: body.sequence, online: body.online, video: body.video, seenAt: Date.now() });
    if (row.usageEstimateStatus === 'awaiting_media_state') this.db.updateSession(sessionId, { usageEstimateStatus: 'local_estimate' });
    if (!existing || existing.online !== body.online || existing.video !== body.video) this.refreshBudgets();
  }
  disconnect(sessionId: string, presenceId: string, role: 'publisher' | 'subscriber') {
    this.settle(sessionId);
    for (const client of this.meters.get(sessionId)?.clients.values() || []) if (client.role === role && client.presenceId === presenceId) client.online = false;
    this.refreshBudgets();
  }
  finish(sessionId: string) { this.settle(sessionId); this.meters.delete(sessionId); }

  @Interval(30_000)
  checkpoint() {
    for (const id of this.meters.keys()) {
      const row = this.db.getSessionById(id);
      if (!row || row.status === 'ended') { this.meters.delete(id); continue; }
      this.settle(id);
      this.analytics.recordShareMetrics(this.db.getSessionById(id));
    }
    this.refreshBudgets();
  }
  flush() { for (const id of this.meters.keys()) this.settle(id); }

  balance(account: AgoraAccount, now = Date.now()) {
    const baselines = this.accounts.baselines(account, now), month = monthKey(now), baseline = baselines[month];
    if (!baseline) return { month, remainingStandardMinutes: null, safeRemainingStandardMinutes: null, usedStandardSeconds: null, estimateStatus: 'baseline_required', usageCalibratedAt: account.last_sync_at };
    const [, end] = monthBounds(month);
    const rows = this.sql.prepare('SELECT * FROM agora_usage_daily WHERE account_id=? AND utc_date>=? AND utc_date<=?').all(account.id, utcDate(baseline.at), utcDate(Math.min(end - 1, now))) as DailyUsage[];
    let used = MONTHLY_STANDARD_SECONDS - baseline.remainingStandardMinutes * 60, unknown = false, calibrated = false;
    for (const row of rows) {
      const start = Date.parse(row.utc_date), stop = start + DAY_MS;
      const local = localUsage(row.local_json);
      if (start >= baseline.at && stop <= end && row.calibrated_standard_seconds != null) {
        used += row.calibrated_standard_seconds; unknown ||= !!row.unknown_mode; calibrated = true;
      } else for (const segment of local.segments) used += segmentSeconds(segment, baseline.at, Math.min(now, end));
    }
    return { month, usedStandardSeconds: used, remainingStandardMinutes: Math.max(0, MONTHLY_STANDARD_SECONDS - used) / 60,
      safeRemainingStandardMinutes: Math.max(0, MONTHLY_STANDARD_SECONDS - used - SAFETY_STANDARD_SECONDS) / 60,
      estimateStatus: unknown ? 'unknown_mode_estimate' : calibrated ? 'calibrated_estimate' : 'local_estimate', usageCalibratedAt: account.last_sync_at };
  }
  list(spaceId?: string) {
    this.flush();
    return (spaceId ? this.accounts.forSpace(spaceId) : this.accounts.all()).map(account => {
      const balance = this.balance(account);
      return { ...this.accounts.publicInfo(spaceId ? this.accounts.spaceAccount(spaceId, account.id) : this.accounts.get(account.id)), ...balance,
        ...(spaceId ? { canUnlink: this.accounts.canUnlink(spaceId, account) } : {}) };
    });
  }
  async sync(id: string, automatic = false, now = Date.now()) {
    if (this.syncing.has(id)) throw new ConflictException('该账号正在校准');
    const account = this.accounts.get(id), day = hkDate(now);
    if (!account.customer_id || !account.customer_secret || !account.project_id) throw new ConflictException('请先补充并验证 RESTful 凭证');
    const attempts = account.sync_day === day ? account.sync_attempts : 0;
    if (automatic && attempts >= 3) return;
    this.syncing.add(id);
    try {
      this.flush();
      const baselines = this.accounts.baselines(account, now);
      const months = [monthKey(monthBounds(monthKey(now))[0] - 1), monthKey(now)];
      const ranges = months.flatMap(month => baselines[month] && calibrationRange(month, baselines[month], now) ? [{ month, range: calibrationRange(month, baselines[month], now)! }] : []);
      if (!ranges.length) {
        this.sql.prepare("UPDATE agora_accounts SET sync_status=?,sync_error='',sync_day=?,sync_attempts=?,next_sync_at=0 WHERE id=?").run(Object.keys(baselines).length ? 'waiting_complete_day' : 'baseline_required', day, attempts, id);
        return;
      }
      if (automatic) this.sql.prepare('UPDATE agora_accounts SET sync_day=?,sync_attempts=?,next_sync_at=?,last_attempt_at=? WHERE id=?').run(day, attempts + 1, attempts < 2 ? now + (attempts === 0 ? 60_000 : 300_000) : 0, now, id);
      const collected: Array<[string, ReturnType<typeof parseOfficialUsage>]> = [];
      for (const { range } of ranges) {
        const [from, to] = range;
        const params = new URLSearchParams({ project_id: account.project_id, from_date: from, to_date: to, business: 'default' });
        const response = await agoraGet('/dev/v3/usage?' + params, account.customer_id, account.customer_secret);
        collected.push([from, parseOfficialUsage(response, from, to)]);
      }
      if (this.accounts.get(id).updated_at !== account.updated_at) throw new AgoraApiError('sync_configuration_changed');
      this.sql.transaction(() => {
        for (const [, rows] of collected) for (const [date, official] of rows) {
          const local = this.sql.prepare('SELECT local_json FROM agora_usage_daily WHERE account_id=? AND utc_date=?').get(id, date) as any;
          const estimate = calibrateUsage(official, localUsage(local?.local_json || '').buckets);
          this.sql.prepare(`INSERT INTO agora_usage_daily(account_id,utc_date,official_json,calibrated_standard_seconds,calibrated_at,unknown_mode) VALUES(?,?,?,?,?,?)
            ON CONFLICT(account_id,utc_date) DO UPDATE SET official_json=excluded.official_json,calibrated_standard_seconds=excluded.calibrated_standard_seconds,calibrated_at=excluded.calibrated_at,unknown_mode=excluded.unknown_mode`).run(id, date, JSON.stringify(official), estimate.seconds, now, estimate.unknownMode ? 1 : 0);
        }
        this.sql.prepare("UPDATE agora_accounts SET sync_status='success',sync_error='',last_sync_at=?,sync_day=?,sync_attempts=?,next_sync_at=0 WHERE id=?").run(now, day, automatic ? attempts + 1 : attempts, id);
      })();
    } catch (error) {
      const failure = error instanceof AgoraApiError ? error : new AgoraApiError('sync_failed');
      const next = automatic && failure.retryable && attempts < 2 ? now + Math.max(attempts === 0 ? 60_000 : 300_000, failure.retryAfterMs) : 0;
      if (automatic) this.sql.prepare("UPDATE agora_accounts SET sync_status='failed',sync_error=?,next_sync_at=? WHERE id=?").run(failure.code, next, id);
      else this.sql.prepare("UPDATE agora_accounts SET sync_status='failed',sync_error=? WHERE id=?").run(failure.code, id);
    } finally { this.syncing.delete(id); }
  }
  @Interval(30_000)
  async runDue(now = Date.now()) {
    const day = hkDate(now), scheduled = Date.parse(day + 'T10:00:00+08:00');
    for (const account of this.accounts.all()) {
      if (!account.customer_id || !account.customer_secret || !account.project_id || this.syncing.has(account.id) || now < scheduled) continue;
      if (account.sync_day !== day || (account.next_sync_at > 0 && now >= account.next_sync_at)) await this.sync(account.id, true, now);
    }
  }
}
