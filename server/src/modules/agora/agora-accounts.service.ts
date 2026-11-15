import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { agoraGet, AgoraApiError, monthBounds, monthKey, UsageBaseline, UsageBaselines } from './agora-usage.math';

export interface AgoraAccount {
  id: string; label: string; enabled: number; app_id: string; app_certificate: string;
  customer_id: string; customer_secret: string; project_id: string; baselines_json: string;
  sync_day: string; sync_attempts: number; next_sync_at: number; last_attempt_at: number | null;
  last_sync_at: number | null; sync_status: string; sync_error: string; updated_at: number;
}

@Injectable()
export class AgoraAccountsService {
  constructor(private readonly db: DatabaseService) {}
  private get sql() { return this.db.integrationDatabase; }
  all(): AgoraAccount[] { return this.sql.prepare('SELECT * FROM agora_accounts ORDER BY id').all() as AgoraAccount[]; }
  get(id: string): AgoraAccount {
    const account = this.sql.prepare('SELECT * FROM agora_accounts WHERE id=?').get(id) as AgoraAccount;
    if (!account) throw new NotFoundException('声网账号不存在');
    return account;
  }
  byAppId(appId: string): AgoraAccount | undefined {
    return this.sql.prepare('SELECT * FROM agora_accounts WHERE app_id=?').get(appId.toLowerCase()) as AgoraAccount;
  }
  activeUse(account: AgoraAccount): boolean {
    return !!this.sql.prepare(`SELECT 1 FROM sessions s LEFT JOIN servers v ON v.server_id=s.server_id
      WHERE s.status!='ended' AND (s.agora_account_id=? OR (v.platform='heychat' AND s.started_at IS NOT NULL AND s.agora_account_id IS NULL AND LOWER(COALESCE(NULLIF(s.agora_app_id,''),v.agora_app_id))=?)) LIMIT 1`).get(account.id, account.app_id);
  }
  publicInfo(account: AgoraAccount) {
    return {
      id: account.id, label: account.label, enabled: !!account.enabled, appId: account.app_id,
      appCertificate: '******', customerId: account.customer_id, customerSecret: '******', projectId: account.project_id,
      baselines: JSON.parse(account.baselines_json) as UsageBaselines,
      lastSyncAt: account.last_sync_at, syncStatus: account.sync_status, syncError: account.sync_error,
      syncDay: account.sync_day, syncAttempts: account.sync_attempts, nextSyncAt: account.next_sync_at,
      inUse: this.activeUse(account),
    };
  }
  private text(value: unknown, label: string, max: number) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw new BadRequestException(`${label}无效`);
    return value.trim();
  }
  async save(id: string | undefined, body: any): Promise<AgoraAccount> {
    const before = id ? this.get(id) : undefined;
    const label = this.text(body?.label, '公开备注', 64);
    const enabled = body?.enabled;
    if (typeof enabled !== 'boolean') throw new BadRequestException('启用状态无效');
    const appId = this.text(body?.appId, 'App ID', 32).toLowerCase();
    const keep = (value: unknown, previous: string | undefined) => value === undefined || (typeof value === 'string' && ['', '******'].includes(value.trim())) ? previous : value;
    const certificate = this.text(keep(body?.appCertificate, before?.app_certificate), 'App Certificate', 32).toLowerCase();
    const customerId = this.text(body?.customerId, 'Customer ID', 128);
    const secret = this.text(keep(body?.customerSecret, before?.customer_secret), 'Customer Secret', 256);
    if (!/^[a-f0-9]{32}$/.test(appId) || !/^[a-f0-9]{32}$/.test(certificate) || !/^[a-zA-Z0-9_-]+$/.test(customerId)) throw new BadRequestException('声网凭证格式无效');
    if (before && this.activeUse(before) && (appId !== before.app_id || certificate !== before.app_certificate)) throw new ConflictException('账号有未结束会话，不能更换 App ID 或发布证书');
    if (before && appId !== before.app_id && (!body?.appCertificate || body.appCertificate === '******')) throw new BadRequestException('更换 App ID 时请填写配套证书');
    const duplicate = this.all().some(a => a.id !== id && (a.app_id === appId || a.customer_id === customerId));
    if (duplicate) throw new BadRequestException('该 App ID 或 RESTful 账号已配置，不能重复计算免费额度');
    let requestedBaseline: UsageBaseline | undefined;
    if (body?.baseline !== undefined) {
      const { at, remainingStandardMinutes } = body.baseline || {};
      if (!Number.isFinite(at) || at <= 0 || at > Date.now() || !Number.isFinite(remainingStandardMinutes) || remainingStandardMinutes < 0 || remainingStandardMinutes > 10_000) throw new BadRequestException('基准时间或剩余标准分钟无效');
      requestedBaseline = { at, remainingStandardMinutes, source: 'manual' };
    }
    let projectId = before?.project_id;
    if (!before || appId !== before.app_id || customerId !== before.customer_id || secret !== before.customer_secret) {
      try {
        const response = await agoraGet('/dev/v1/projects', customerId, secret);
        if (!Array.isArray(response?.projects)) throw new AgoraApiError('api_schema');
        if (this.all().some(account => account.id !== id && response.projects.some(project => project.id === account.project_id))) throw new AgoraApiError('account_already_configured');
        const project = response.projects.find(p => p.vendor_key?.toLowerCase() === appId);
        if (!project || typeof project.id !== 'string' || project.status !== 1) throw new AgoraApiError('project_not_enabled');
        projectId = project.id;
      } catch (error) {
        throw new BadRequestException(`声网凭证验证失败：${error instanceof AgoraApiError ? error.code : 'api_error'}`);
      }
    }
    // Recheck after the read-only HTTP request; another request may have started sharing meanwhile.
    if (before && this.activeUse(before) && (appId !== before.app_id || certificate !== before.app_certificate)) throw new ConflictException('账号正在使用，请结束会话后再更换发布凭证');
    const latest = id ? this.get(id) : undefined;
    if (before && latest.updated_at !== before.updated_at) throw new ConflictException('账号已更新，请刷新后重试');
    const baselines: UsageBaselines = JSON.parse(latest?.baselines_json || '{}');
    if (requestedBaseline) baselines[monthKey(requestedBaseline.at)] = requestedBaseline;
    const accountId = id || randomUUID();
    try {
      this.sql.prepare(`INSERT INTO agora_accounts(id,label,enabled,app_id,app_certificate,customer_id,customer_secret,project_id,baselines_json,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,enabled=excluded.enabled,
        app_id=excluded.app_id,app_certificate=excluded.app_certificate,customer_id=excluded.customer_id,
        customer_secret=excluded.customer_secret,project_id=excluded.project_id,baselines_json=excluded.baselines_json,updated_at=excluded.updated_at`).run(
        accountId, label, enabled ? 1 : 0, appId, certificate, customerId, secret, projectId, JSON.stringify(baselines), Math.max(Date.now(), (before?.updated_at || 0) + 1));
    } catch (error) {
      if ((error as any)?.code?.startsWith('SQLITE_CONSTRAINT')) throw new BadRequestException('App ID、RESTful 账号或项目已存在');
      throw error;
    }
    return this.get(accountId);
  }
  baselines(account: AgoraAccount, now = Date.now()): UsageBaselines {
    const baselines: UsageBaselines = JSON.parse(account.baselines_json);
    const month = monthKey(now);
    if (!baselines[month] && Object.keys(baselines).some(key => key < month)) {
      baselines[month] = { at: monthBounds(month)[0], remainingStandardMinutes: 10_000, source: 'monthly_reset' };
      this.sql.prepare('UPDATE agora_accounts SET baselines_json=? WHERE id=?').run(JSON.stringify(baselines), account.id);
    }
    return baselines;
  }
  remove(id: string) {
    const account = this.get(id);
    if (this.activeUse(account)) throw new ConflictException('请先结束该账号的全部会话；可先停用账号');
    const used = this.sql.prepare('SELECT 1 FROM agora_usage_daily WHERE account_id=? LIMIT 1').get(id);
    if (used) throw new ConflictException('账号已有用量账本，请停用以保留历史');
    this.sql.prepare('DELETE FROM agora_accounts WHERE id=?').run(id);
    return { ok: true };
  }
}
