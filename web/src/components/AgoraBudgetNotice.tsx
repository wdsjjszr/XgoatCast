import type { AgoraBudget } from '../types';

export default function AgoraBudgetNotice({ budget }: { budget: AgoraBudget }) {
  if (!budget.agoraAccountLabel) return null;
  const seconds = budget.estimatedRemainingSec;
  const urgent = seconds != null && seconds < 300;
  const low = seconds != null && seconds < 900;
  const estimate = seconds == null
    ? budget.remainingStandardMinutes == null ? '余量未知，请管理员补充余额基准' : '暂无在线媒体记录，传输后更新预计时长'
    : `按当前负载预计可用约 ${Math.max(0, Math.floor(seconds / 60))} 分钟`;
  const status = budget.budgetEstimateStatus === 'calibrated_estimate' ? '官方用量校准后的估算'
    : budget.budgetEstimateStatus === 'unknown_mode_estimate' ? '校准估算 · 部分模式未知' : '本地估算';
  const time = (at: number) => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false });
  return <div role={low ? 'alert' : 'status'} className={`w-full rounded-lg border px-4 py-3 text-sm ${urgent ? 'border-[#a0342d] bg-[#fff0ed] text-[#a0342d]' : low ? 'border-[#c9924c] bg-[#fff6e8] text-[#895216]' : 'border-[#d9ddd6] bg-[#fffefd] text-[#5b5e59]'}`}>
    <p className="break-words">账号：{budget.agoraAccountLabel} · {estimate}{urgent ? ' · 额度即将耗尽，请尽快结束共享' : low ? ' · 额度偏低' : ''}</p>
    <p className="mt-1 text-xs">{status} · 已预留 300 标准分钟{budget.budgetUpdatedAt ? ` · 更新于 ${time(budget.budgetUpdatedAt)}` : ''}{budget.usageCalibratedAt ? ` · 最近校准 ${time(budget.usageCalibratedAt)}` : ' · 尚未校准'}</p>
  </div>;
}
