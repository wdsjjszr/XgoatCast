import { useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { api, type AgoraAccountSpace } from '../../lib/api';
import type { AgoraAccountInfo, AgoraAccountWrite } from '../../types/agora';

const input = 'mt-1 w-full rounded-lg border border-white/10 bg-surface-dark px-3 py-2 text-sm';
const time = (at: number | null) => at ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false }) : '尚未校准';
const minutes = (value: number | null) => value == null ? '未知' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const STATUS: Record<string, string> = { not_synced: '尚未校准', success: '校准成功', failed: '校准失败', waiting_complete_day: '等待完整历史日', baseline_required: '需要初始化基准' };
const ESTIMATE: Record<string, string> = { baseline_required: '余量未知', local_estimate: '本地估算', calibrated_estimate: '官方用量校准后的估算', unknown_mode_estimate: '校准估算 · 部分模式未知' };
const emptyForm = (): AgoraAccountWrite => ({ label: '', enabled: true, appId: '', appCertificate: '', customerId: '', customerSecret: '' });
const hkInputTime = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16);

export default function AgoraAccountsPanel({ space }: { space?: AgoraAccountSpace } = {}) {
  const [accounts, setAccounts] = useState<AgoraAccountInfo[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [setBaseline, setSetBaseline] = useState(false), [remaining, setRemaining] = useState(''), [baselineAt, setBaselineAt] = useState(hkInputTime);
  const load = async () => setAccounts(await api.getAgoraAccounts(space));
  useEffect(() => { load().catch(e => setMessage(e.message)).finally(() => setLoading(false)); }, [space?.platform, space?.externalId]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await action(); } catch (e: any) { setMessage(e.message || '操作失败'); } finally { setBusy(false); }
  };
  const edit = (account?: AgoraAccountInfo) => {
    setEditing(account?.id || 'new'); setMessage(''); setSetBaseline(false); setRemaining(''); setBaselineAt(hkInputTime());
    setForm(account ? { label: account.label, enabled: account.enabled, appId: account.appId, appCertificate: '', customerId: account.customerId, customerSecret: '' } : emptyForm());
  };
  const selected = accounts.find(a => a.id === editing);
  return <div className="max-w-5xl space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold">{space ? '本空间声网账号池' : '声网账号总览与维护'}</h2><p className="mt-1 text-sm text-muted">实时用量在本地分段累计；每天 10:00（香港时间）校准完整历史日。</p></div>
      <div className="flex gap-2"><button disabled={busy} onClick={() => run(load)} aria-label="刷新声网账号" className="rounded-lg border border-white/10 p-2"><RefreshCw size={18} /></button>
        <button disabled={busy} onClick={() => edit()} className="btn-brand inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm"><Plus size={17} />添加账号</button></div>
    </div>
    <p className="rounded-xl border border-white/10 p-4 text-sm text-muted">每个免费账号只配置一个实际使用的 RTC 项目，安全可用量预留 300 标准分钟。首次接入请录入控制台剩余量与对应时间。{space ? '新增备用账号不会改变当前单账号共享配置。' : '此处维护真实账号账本，不向任何空间自动开放使用权。'}</p>
    {space && <p className="text-sm text-muted"><input type="checkbox" disabled checked={false} aria-label="自动轮转（尚未开放）" className="mr-2" />自动轮转尚未开放，待 P3 分配协议就绪；当前仍使用上方单账号配置。</p>}
    {message && <p role="status" className="rounded-lg border border-orange-400/30 bg-orange-400/5 p-3 text-sm break-words">{message}</p>}
    {loading ? <p className="text-sm text-muted">正在读取账号…</p> : !accounts.length && editing === null ? <div className="glass rounded-xl p-8"><h3 className="font-medium">先接入一个声网账号</h3><p className="mt-2 text-sm text-muted">准备 App ID、发布证书和 RESTful 凭证，保存时会只读验证项目。</p><button onClick={() => edit()} className="btn-brand mt-4 rounded-lg px-4 py-2 text-sm">添加账号</button></div> : null}
    {editing !== null && <form className="glass rounded-xl p-5 sm:p-6" onSubmit={e => { e.preventDefault(); void run(async () => {
      const body = { ...form, ...(setBaseline ? { baseline: { at: Date.parse(baselineAt + ':00+08:00'), remainingStandardMinutes: Number(remaining) } } : {}) };
      await api.saveAgoraAccount(editing === 'new' ? undefined : editing, body, space);
      setForm(emptyForm()); setEditing(null); await load(); setMessage('账号已保存。');
    }); }}><fieldset disabled={busy} className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-semibold">{editing === 'new' ? '添加声网账号' : '编辑声网账号'}</h3><button type="button" className="text-sm text-muted underline" onClick={() => { setEditing(null); setForm(emptyForm()); }}>取消</button></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">公开备注<input className={input} value={form.label} maxLength={64} required onChange={e => setForm({ ...form, label: e.target.value })} /><span className="mt-1 block text-xs text-muted">备注会显示在共享和观看页面，请勿填入秘密。</span></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />{space ? '启用本空间条目（供后续新会话分配）' : '总览启用标记（不控制空间分配）'}</label>
        <label className="text-sm">App ID<input className={input} value={form.appId} pattern="[a-fA-F0-9]{32}" maxLength={32} required disabled={selected?.inUse || (!!space && !!selected)} onChange={e => setForm({ ...form, appId: e.target.value })} /></label>
        <label className="text-sm">App Certificate<input className={input} type="password" autoComplete="new-password" value={form.appCertificate} maxLength={32} required={!selected} disabled={selected?.inUse} placeholder={selected ? '已设置，留空保留' : '32 位发布证书'} onChange={e => setForm({ ...form, appCertificate: e.target.value })} /></label>
        <label className="text-sm">RESTful Customer ID<input className={input} autoComplete="off" value={form.customerId} maxLength={128} required={!selected || !!selected.projectId} onChange={e => setForm({ ...form, customerId: e.target.value })} /></label>
        <label className="text-sm">RESTful Customer Secret<input className={input} type="password" autoComplete="new-password" value={form.customerSecret} maxLength={256} required={!selected || (!selected.projectId && !!form.customerId)} placeholder={selected?.customerSecret ? '已设置，留空保留' : 'RESTful Secret'} onChange={e => setForm({ ...form, customerSecret: e.target.value })} /></label>
      </div>
      {selected?.inUse && <p className="text-sm text-muted">该账号有未结束会话，发布凭证已锁定；公开备注、启用状态和查询凭证仍可更新。</p>}
      <p className="text-sm text-muted">同一真实账号的余额、基准、查询及发布凭证由所有授权使用处共用，修改会影响其他使用处；公开备注和启用状态仅作用于{space ? '本空间' : '总览，不控制空间分配'}。更换账号身份请新增账号。</p>
      <div className="border-t border-white/10 pt-4 space-y-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={setBaseline} onChange={e => setSetBaseline(e.target.checked)} />{selected ? '用控制台剩余量重新设定月度基准' : '录入控制台当前剩余标准分钟'}</label>
        {setBaseline && <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">剩余标准分钟（估算）<input className={input} type="number" min={0} max={10000} step="any" required value={remaining} onChange={e => setRemaining(e.target.value)} /></label><label className="text-sm">对应时间（香港时间）<input className={input} type="datetime-local" required value={baselineAt} onChange={e => setBaselineAt(e.target.value)} /></label></div>}
        <p className="text-sm text-muted">基准之后先使用本地估算，官方校准仅覆盖可完整对齐的 UTC 日，并保留前两天的数据延迟窗口。</p></div>
      <button className="btn-brand rounded-lg px-5 py-2.5 text-sm" type="submit">{busy ? '正在验证并保存…' : '验证并保存'}</button>
    </fieldset></form>}
    <div className="grid gap-4 lg:grid-cols-2">{accounts.map(account => <section key={account.id} className="glass rounded-xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold break-words">{account.label}</h3><p className="mt-1 text-xs text-muted">{account.month} · {account.enabled ? '已启用' : '已停用'}{account.inUse ? ' · 有未结束会话' : ''}</p></div><span className="text-xs text-brand-light">{ESTIMATE[account.estimateStatus] || account.estimateStatus}</span></div>
      <div><p className="text-sm text-muted">安全可用标准分钟</p><p className="mt-1 text-3xl font-semibold tabular-nums">{minutes(account.safeRemainingStandardMinutes)}</p><p className="mt-2 text-sm text-muted">{account.remainingStandardMinutes == null ? '请编辑账号，录入月度基准' : `预留前剩余 ${minutes(account.remainingStandardMinutes)} 分钟`}</p></div>
      <dl className="space-y-2 text-sm"><div><dt className="text-muted">最近成功校准（香港时间）</dt><dd>{time(account.usageCalibratedAt)}</dd></div><div><dt className="text-muted">同步状态</dt><dd>{STATUS[account.syncStatus] || account.syncStatus}{account.syncError ? ` · ${account.syncError}` : ''}</dd></div>
        <div><dt className="text-muted">自动尝试</dt><dd>{account.syncDay || '尚未尝试'} · {account.syncAttempts}/3{account.nextSyncAt ? ` · 下次 ${time(account.nextSyncAt)}` : ''}</dd></div></dl>
      <details className="text-sm"><summary className="cursor-pointer text-muted">项目与历史基准</summary><p className="mt-2 break-all font-mono text-xs">App ID：{account.appId}<br />项目 ID：{account.projectId || '待补充并验证 RESTful 凭证（原单账号共享不受影响）'}</p><ul className="mt-2 space-y-2">{Object.entries(account.baselines).sort(([a], [b]) => b.localeCompare(a)).map(([month, baseline]) => <li key={month}>{month}：{minutes(baseline.remainingStandardMinutes)} 分钟 · {time(baseline.at)}{baseline.source === 'monthly_reset' ? '（月度重置）' : '（手工估算）'}</li>)}</ul></details>
      <div className="flex flex-wrap gap-3 border-t border-white/10 pt-4 text-sm"><button disabled={busy} className="text-brand-light" onClick={() => edit(account)}>编辑</button><button disabled={busy || !account.projectId} title={!account.projectId ? '请先编辑并补充 RESTful 凭证' : ''} onClick={() => run(async () => { const result = await api.syncAgoraAccount(account.id, space); await load(); setMessage(`${account.label}：${STATUS[result.syncStatus] || result.syncStatus}${result.syncError ? `（${result.syncError}）` : ''}`); })}>立即校准</button><button disabled={busy || (space ? !account.canUnlink : account.inUse)} title={space ? '当前单账号或本空间仍有绑定会话时，请先停用' : '有历史用量或空间关联的账号请保留'} className="ml-auto text-red-300 disabled:opacity-40" onClick={() => { if (window.confirm(space ? `解除本空间与“${account.label}”的关联？保留真实账号账本和其他空间关联。` : `删除账号“${account.label}”？有历史用量或空间关联时不可删除。`)) void run(async () => { await api.deleteAgoraAccount(account.id, space); await load(); }); }}>{space ? '解除关联' : '删除'}</button></div>
    </section>)}</div>
  </div>;
}
