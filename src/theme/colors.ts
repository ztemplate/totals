export const palette = {
  primaryDark: '#4F46E5',
  primaryLight: '#6366F1',
  red: '#EF4444',
  income: '#10B981',
  amber: '#F59E0B',
  blue: '#3B82F6',
  slate50: '#F8FAFC',
  border: '#E2E8F0',
  slate400: '#94A3B8',
  slate500: '#64748B',
  slate600: '#475569',
  slate700: '#334155',
  slate800: '#1E293B',
  slate900: '#0F172A',
  darkBg: '#161A26',
  darkSurface: '#1E2230',
  darkBorder: '#34384A',
  darkMuted: '#2A3040',
  white: '#FFFFFF',
};

export interface ThemeColors {
  dark: boolean;
  background: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  primary: string;
  primarySoft: string;
  onPrimary: string;
  income: string;
  expense: string;
  warning: string;
  info: string;
}

export const lightColors: ThemeColors = {
  dark: false,
  background: palette.slate50,
  surface: palette.white,
  surfaceMuted: '#F1F5F9',
  border: palette.border,
  text: palette.slate900,
  textSecondary: palette.slate600,
  textMuted: palette.slate400,
  primary: palette.primaryDark,
  primarySoft: '#EEF2FF',
  onPrimary: palette.white,
  income: palette.income,
  expense: palette.red,
  warning: palette.amber,
  info: palette.blue,
};

export const darkColors: ThemeColors = {
  dark: true,
  background: palette.darkBg,
  surface: palette.darkSurface,
  surfaceMuted: palette.darkMuted,
  border: palette.darkBorder,
  text: '#F1F5F9',
  textSecondary: palette.slate400,
  textMuted: palette.slate500,
  primary: palette.primaryLight,
  primarySoft: '#2E2F5B',
  onPrimary: palette.white,
  income: palette.income,
  expense: palette.red,
  warning: palette.amber,
  info: palette.blue,
};

export const radius = {
  card: 8,
  input: 12,
  pill: 999,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

/** Category colour keys used by the Flutter redesign. */
export const categoryColors: Record<string, string> = {
  indigo: '#6366F1',
  blue: '#3B82F6',
  sky: '#0EA5E9',
  teal: '#14B8A6',
  green: '#10B981',
  lime: '#84CC16',
  yellow: '#EAB308',
  amber: '#F59E0B',
  orange: '#F97316',
  red: '#EF4444',
  rose: '#F43F5E',
  pink: '#EC4899',
  purple: '#A855F7',
  violet: '#8B5CF6',
  slate: '#64748B',
  brown: '#92400E',
};

const fallbackCategoryColors = Object.values(categoryColors);

export function categoryColor(colorKey: string | null | undefined, id?: number | null): string {
  if (colorKey && categoryColors[colorKey]) return categoryColors[colorKey];
  if (colorKey && /^#[0-9a-f]{6}$/i.test(colorKey)) return colorKey;
  const index = Math.abs(id ?? 0) % fallbackCategoryColors.length;
  return fallbackCategoryColors[index];
}
