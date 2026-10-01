import { useColorScheme } from 'react-native';
import { create } from 'zustand';
import { prefs, PrefKeys } from '../services/prefs';
import { darkColors, lightColors, type ThemeColors } from '../theme/colors';
import type { CalendarKind } from '../utils/periodUtils';

export type ThemeMode = 'system' | 'light' | 'dark';

interface SettingsState {
  loaded: boolean;
  themeMode: ThemeMode;
  calendar: CalendarKind;
  hideBalances: boolean;
  load(): Promise<void>;
  setThemeMode(mode: ThemeMode): Promise<void>;
  setCalendar(calendar: CalendarKind): Promise<void>;
  setHideBalances(hidden: boolean): Promise<void>;
  toggleHideBalances(): Promise<void>;
}

function parseThemeMode(raw: string | null): ThemeMode {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  themeMode: 'system',
  calendar: 'gregorian',
  hideBalances: false,

  async load() {
    const [themeMode, calendar, hideBalances] = await Promise.all([
      prefs.getString(PrefKeys.themeMode),
      prefs.getString(PrefKeys.calendar),
      prefs.getBool(PrefKeys.hideBalances, false),
    ]);
    set({
      loaded: true,
      themeMode: parseThemeMode(themeMode),
      calendar: calendar === 'ethiopian' ? 'ethiopian' : 'gregorian',
      hideBalances,
    });
  },

  async setThemeMode(themeMode) {
    set({ themeMode });
    await prefs.setString(PrefKeys.themeMode, themeMode);
  },

  async setCalendar(calendar) {
    set({ calendar });
    await prefs.setString(PrefKeys.calendar, calendar);
  },

  async setHideBalances(hideBalances) {
    set({ hideBalances });
    await prefs.setBool(PrefKeys.hideBalances, hideBalances);
  },

  async toggleHideBalances() {
    await get().setHideBalances(!get().hideBalances);
  },
}));

export function useTheme(): ThemeColors {
  const mode = useSettings((s) => s.themeMode);
  const system = useColorScheme();
  const dark = mode === 'dark' || (mode === 'system' && system === 'dark');
  return dark ? darkColors : lightColors;
}
