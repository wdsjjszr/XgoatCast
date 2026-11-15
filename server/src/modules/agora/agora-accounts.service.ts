import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { agoraGet, AgoraApiError, monthBounds, monthKey, UsageBaseline, UsageBaselines } from './agora-usage.math';

export interface AgoraAccount {
  id: string; label: string; enabled: number; app_id: string; app_certificate: string;
  customer_id: string | null; customer_secret: string; project_id: string | null; baselines_json: string;
  sync_day: string; sync_attempts: number; next_sync_at: number; last_attempt_at: number | null;
  last_sync_at: number | null; sync_status: string; sync_error: string; updated_at: number;
}

@Injectable()
export class AgoraAccountsService implements OnModuleInit {
  constructor(private readonly db: DatabaseService) {}
  private get sql() { return this.db.integrationDatabase; }
  onModuleInit() {
    for (const space of this.db.listServers()) if (space.platform === 'heychat') this.syncLegacy(space.serverId);
  }
  spaceAccount(spaceId: string, id: string) {
    const link = this.sql.prepare('SELECT label,enabled FROM agora_space_accounts WHERE space_id=? AND account_id=?').get(spaceId, id) as { label: string; enabled: number };
    if (!link) throw new NotFoundException('本空间未关联该声网账号');
    return { ...this.get(id), label: link.label, enabled: link.enabled };
  }
  forSpace(spaceId: string) {
    this.syncLegacy(spaceId);
    return (this.sql.prepare('SELECT account_id FROM agora_space_accounts WHERE space_id=? ORDER BY account_id').all(spaceId) as { account_id: string }[])
      .map(row => this.spaceAccount(spaceId, row.account_id));
  }
  syncLegacy(spaceId: string) {
    const space = this.db.getServer(spaceId);
    if (!space || space.platform !== 'heychat' || !space.agoraAppId || !space.agoraAppCertificate) return;
    const appId = space.agoraAppId.toLowerCase(), certificate = space.agoraAppCertificate.toLowerCase();
    let account = this.byAppId(appId);
    if (account && account.app_certificate !== certificate) return;
    if (!account) {
      const id = randomUUID();
      this.sql.prepare(`INSERT INTO agora_accounts(id,label,app_id,app_certificate,customer_secret,updated_at) VALUES(?,?,?,?,?,?)`)
        .run(id, '原单账号', appId, certificate, '', Date.now());
      account = this.get(id);
    }
    this.sql.prepare('INSERT OR IGNORE INTO agora_space_accounts(space_id,account_id,label) VALUES(?,?,?)').run(spaceId, account.id, '原单账号');
  }
  updateLegacy(spaceId: string, updates: any) {
    const space = this.db.getServer(spaceId);
    if (space?.platform !== 'heychat') { this.db.updateServer(spaceId, updates); return; }
    this.syncLegacy(spaceId);
    const appId = (updates.agoraAppId ?? space.agoraAppId).trim();
    const certificateInput = updates.agoraAppCertificate?.trim();
    const cert = !certificateInput || certificateInput === '******' ? space.agoraAppCertificate : certificateInput;
    const changed = appId !== space.agoraAppId || cert !== space.agoraAppCertificate;
    if (changed) {
      if (space.agoraAccountPoolEnabled) throw new ConflictException('已启用账号池，请在账号池中编辑凭证');
      if ((appId && !/^[a-f0-9]{32}$/i.test(appId)) || (cert && !/^[a-f0-9]{32}$/i.test(cert))) throw new BadRequestException('App ID 或发布证书格式无效');
      const saved = this.byAppId(space.agoraAppId);
      const previous = saved?.app_certificate === space.agoraAppCertificate.toLowerCase() ? saved : undefined;
      if (previous && (appId.toLowerCase() === previous.app_id ? this.activeUse(previous) : this.spaceInUse(spaceId, previous.id))) throw new ConflictException('请先结束绑定会话再更换凭证');
      const target = this.byAppId(appId);
      if (target && target.id !== previous?.id && target.app_certificate !== cert.toLowerCase()) throw new ConflictException('该 App ID 已有不同凭证，请使用账号池验证关联');
    }
    this.sql.transaction(() => {
      if (changed && appId.toLowerCase() === space.agoraAppId.toLowerCase()) {
        const account = this.byAppId(appId);
        if (account) {
          this.sql.prepare('UPDATE agora_accounts SET app_certificate=?,updated_at=? WHERE id=?').run(cert.toLowerCase(), Math.max(Date.now(), account.updated_at + 1), account.id);
          for (const linked of this.db.listServers()) if (linked.platform === 'heychat' && linked.agoraAppId.toLowerCase() === appId.toLowerCase() && linked.agoraAppCertificate.toLowerCase() === space.agoraAppCertificate.toLowerCase()) {
            this.db.updateServer(linked.serverId, { agoraAppCertificate: cert });
          }
        }
      }
      this.db.updateServer(spaceId, { ...updates, agoraAppId: appId, agoraAppCertificate: cert }); this.syncLegacy(spaceId);
    })();
  }
  unlink(spaceId: string, id: string) {
    this.spaceAccount(spaceId, id);
    if (this.spaceInUse(spaceId, id)) throw new ConflictException('本空间有未结束的绑定会话，请先停用');
    const space = this.db.getServer(spaceId);
    if (space?.agoraAppId.toLowerCase() === this.get(id).app_id) throw new ConflictException('当前单账号需保留关联，请先更换单账号配置');
    this.sql.prepare('DELETE FROM agora_space_accounts WHERE space_id=? AND account_id=?').run(spaceId, id);
    return { ok: true };
  }
  spaceInUse(spaceId: string, id: string): boolean {
    return !!this.sql.prepare(`SELECT 1 FROM sessions WHERE server_id=? AND status!='ended' AND
      (agora_account_id=? OR (agora_account_id IS NULL AND LOWER(agora_app_id)=?)) LIMIT 1`).get(spaceId, id, this.get(id).app_id);
  }
  canUnlink(spaceId: string, account: AgoraAccount): boolean {
    return this.db.getServer(spaceId)?.agoraAppId.toLowerCase() !== account.app_id && !this.spaceInUse(spaceId, account.id);
  }
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
      WHERE s.status!='ended' AND (s.agora_account_id=? OR (v.platform='heychat' AND (s.started_at IS NOT NULL OR s.agora_app_id!='') AND s.agora_account_id IS NULL AND LOWER(COALESCE(NULLIF(s.agora_app_id,''),v.agora_app_id))=?)) LIMIT 1`).get(account.id, account.app_id);
  }
  publicInfo(account: AgoraAccount) {
    return {
      id: account.id, label: account.label, enabled: !!account.enabled, appId: account.app_id,
      appCertificate: '******', customerId: account.customer_id || '', customerSecret: account.customer_secret ? '******' : '', projectId: account.project_id || '',
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
  async save(id: string | undefined, body: any, spaceId?: string): Promise<AgoraAccount> {
    const before = id ? (spaceId ? this.spaceAccount(spaceId, id) : this.get(id)) : undefined;
    const label = this.text(body?.label, '公开备注', 64);
    const enabled = body?.enabled;
    if (typeof enabled !== 'boolean') throw new BadRequestException('启用状态无效');
    const appId = this.text(body?.appId, 'App ID', 32).toLowerCase();
    const keep = (value: unknown, previous: string | undefined) => value === undefined || (typeof value === 'string' && ['', '******'].includes(value.trim())) ? previous : value;
    const certificate = this.text(keep(body?.appCertificate, before?.app_certificate), 'App Certificate', 32).toLowerCase();
    const legacy = !!before && !before.project_id && !body?.customerId && !body?.customerSecret;
    const customerId = legacy ? null : this.text(body?.customerId, 'Customer ID', 128);
    const secret = legacy ? '' : this.text(keep(body?.customerSecret, before?.customer_secret), 'Customer Secret', 256);
    if (!/^[a-f0-9]{32}$/.test(appId) || !/^[a-f0-9]{32}$/.test(certificate) || (customerId && !/^[a-zA-Z0-9_-]+$/.test(customerId))) throw new BadRequestException('声网凭证格式无效');
    if (before && appId !== before.app_id && (spaceId || this.sql.prepare('SELECT 1 FROM agora_space_accounts WHERE account_id=?').get(id))) throw new BadRequestException('更换账号身份请添加新账号，再解除旧关联');
    if (before && this.activeUse(before) && (appId !== before.app_id || certificate !== before.app_certificate)) throw new ConflictException('账号有未结束会话，不能更换 App ID 或发布证书');
    if (before && appId !== before.app_id && (!body?.appCertificate || body.appCertificate === '******')) throw new BadRequestException('更换 App ID 时请填写配套证书');
    let requestedBaseline: UsageBaseline | undefined;
    if (body?.baseline !== undefined) {
      const { at, remainingStandardMinutes } = body.baseline || {};
      if (!Number.isFinite(at) || at <= 0 || at > Date.now() || !Number.isFinite(remainingStandardMinutes) || remainingStandardMinutes < 0 || remainingStandardMinutes > 10_000) throw new BadRequestException('基准时间或剩余标准分钟无效');
      requestedBaseline = { at, remainingStandardMinutes, source: 'manual' };
    }
    let projectId = before?.project_id || null;
    const shared = !id && spaceId ? this.byAppId(appId) : undefined;
    if (!legacy && (!before || !before.project_id || appId !== before.app_id || customerId !== before.customer_id || secret !== before.customer_secret)) {
      try {
        const response = await agoraGet('/dev/v1/projects', customerId, secret);
        if (!Array.isArray(response?.projects)) throw new AgoraApiError('api_schema');
        if (this.all().some(account => account.id !== (id || shared?.id) && (account.app_id === appId || account.customer_id === customerId || response.projects.some(project => project.id === account.project_id)))) throw new AgoraApiError('account_already_configured');
        const project = response.projects.find(p => p.vendor_key?.toLowerCase() === appId);
        if (!project || typeof project.id !== 'string' || project.status !== 1) throw new AgoraApiError('project_not_enabled');
        projectId = project.id;
        if (shared && shared.app_certificate !== certificate) throw new AgoraApiError('credential_mismatch');
      } catch (error) {
        throw new BadRequestException(`声网凭证验证失败：${error instanceof AgoraApiError ? error.code : 'api_error'}`);
      }
    }
    // Recheck after the read-only HTTP request; another request may have started sharing meanwhile.
    if (before && this.activeUse(before) && (appId !== before.app_id || certificate !== before.app_certificate)) throw new ConflictException('账号正在使用，请结束会话后再更换发布凭证');
    if (shared) {
      const latestShared = this.get(shared.id);
      if (latestShared.updated_at !== shared.updated_at) throw new ConflictException('账号已更新，请刷新后重试');
      id = shared.id;
    }
    const latest = id ? this.get(id) : undefined;
    if (before && spaceId) this.spaceAccount(spaceId, id);
    if (before && latest.updated_at !== before.updated_at) throw new ConflictException('账号已更新，请刷新后重试');
    const baselines: UsageBaselines = JSON.parse(latest?.baselines_json || '{}');
    if (requestedBaseline) baselines[monthKey(requestedBaseline.at)] = requestedBaseline;
    const accountId = id || randomUUID();
    try {
      this.sql.transaction(() => {
        this.sql.prepare(`INSERT INTO agora_accounts(id,label,enabled,app_id,app_certificate,customer_id,customer_secret,project_id,baselines_json,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,enabled=excluded.enabled,
          app_id=excluded.app_id,app_certificate=excluded.app_certificate,customer_id=excluded.customer_id,
          customer_secret=excluded.customer_secret,project_id=excluded.project_id,baselines_json=excluded.baselines_json,updated_at=excluded.updated_at`).run(
          accountId, spaceId && latest ? latest.label : label, spaceId && latest ? latest.enabled : enabled ? 1 : 0, appId, certificate, customerId, secret, projectId, JSON.stringify(baselines), Math.max(Date.now(), (latest?.updated_at || 0) + 1));
        if (spaceId) this.sql.prepare(`INSERT INTO agora_space_accounts(space_id,account_id,label,enabled) VALUES(?,?,?,?)
          ON CONFLICT(space_id,account_id) DO UPDATE SET label=excluded.label,enabled=excluded.enabled`).run(spaceId, accountId, label, enabled ? 1 : 0);
        if (latest && (latest.app_id !== appId || latest.app_certificate !== certificate)) {
          for (const space of this.db.listServers()) {
            if (space.platform === 'heychat' && space.agoraAppId.toLowerCase() === latest.app_id && space.agoraAppCertificate.toLowerCase() === latest.app_certificate) {
              this.db.updateServer(space.serverId, { agoraAppId: appId, agoraAppCertificate: certificate });
            }
          }
        }
      })();
    } catch (error) {
      if ((error as any)?.code?.startsWith('SQLITE_CONSTRAINT')) throw new BadRequestException('App ID、RESTful 账号或项目已存在');
      throw error;
    }
    return spaceId ? this.spaceAccount(spaceId, accountId) : this.get(accountId);
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
    if (this.sql.prepare('SELECT 1 FROM agora_space_accounts WHERE account_id=?').get(id)) throw new ConflictException('账号仍有关联空间，请先解除关联');
    this.sql.prepare('DELETE FROM agora_accounts WHERE id=?').run(id);
    return { ok: true };
  }
}
