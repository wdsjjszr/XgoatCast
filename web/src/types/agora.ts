export interface AgoraAccountInfo {
  id: string; label: string; enabled: boolean; appId: string; appCertificate: string;
  customerId: string; customerSecret: string; projectId: string; inUse: boolean;
  canUnlink?: boolean;
  baselines: Record<string, { at: number; remainingStandardMinutes: number; source: string }>;
  month: string; remainingStandardMinutes: number | null; safeRemainingStandardMinutes: number | null;
  usedStandardSeconds: number | null; estimateStatus: string; usageCalibratedAt: number | null;
  syncStatus: string; syncError: string; syncDay: string; syncAttempts: number; nextSyncAt: number;
}
export interface AgoraAccountWrite {
  label: string; enabled: boolean; appId: string; appCertificate: string; customerId: string; customerSecret: string;
  baseline?: { at: number; remainingStandardMinutes: number };
}
