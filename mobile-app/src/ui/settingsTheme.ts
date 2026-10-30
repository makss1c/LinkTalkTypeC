export type SettingsScheme = 'light' | 'dark';

export type SettingsPalette = {
  sheet: string;
  card: string;
  text: string;
  muted: string;
  separator: string;
  link: string;
  danger: string;
  selected: string;
  chevron: string;
  disabled: string;
};

/** LinkTalk всегда тёмный: чёрный корпус, оранжевые акценты. */
const DARK: SettingsPalette = {
  sheet: '#060606',
  card: '#101011',
  text: '#F2F2F2',
  muted: 'rgba(242,242,242,0.58)',
  separator: 'rgba(255,255,255,0.07)',
  link: '#FF6B1A',
  danger: '#FF8A5B',
  selected: 'rgba(255,107,26,0.14)',
  chevron: '#5A5A5E',
  disabled: '#47474A',
};

export function settingsScheme(_value: string | null | undefined): SettingsScheme {
  return 'dark';
}

export function settingsPalette(_scheme: SettingsScheme | string | null | undefined): SettingsPalette {
  return DARK;
}
