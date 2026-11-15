export interface ViewPreferences {
  theme: 'light' | 'dark';
  volume: number;
  muted: boolean;
  pageFullscreen: boolean;
}

const KEY = 'xgoat_view_preferences';
const DEFAULTS: ViewPreferences = { theme: 'light', volume: 100, muted: false, pageFullscreen: false };

export function readViewPreferences(): ViewPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      theme: saved?.theme === 'dark' ? 'dark' : 'light',
      volume: typeof saved?.volume === 'number' && Number.isFinite(saved.volume)
        ? Math.max(0, Math.min(100, saved.volume)) : 100,
      muted: saved?.muted === true,
      pageFullscreen: saved?.pageFullscreen === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveViewPreferences(preferences: ViewPreferences): void {
  try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch {}
}
