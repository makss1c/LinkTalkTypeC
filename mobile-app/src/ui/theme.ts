/**
 * LinkTalk design system v2 «Signal».
 * Глубокий чёрный фон, тёплый белый текст, один акцент — оранжевый. Мягкие крупные скругления,
 * слои поверхностей вместо рамок, свечение вместо светодиодных полос.
 * Тэлли (красный PGM / зелёный PRV) — функциональные цвета, не часть темы.
 */
export const colors = {
  bg: '#060606',
  bgTop: '#0C0C0D',
  bgBottom: '#060606',
  s1: '#101011',
  s2: '#171718',
  s3: '#212123',
  hairline: 'rgba(255,255,255,0.07)',
  hairlineStrong: 'rgba(255,255,255,0.14)',

  text: '#F6F2ED',
  muted: 'rgba(246,242,237,0.58)',
  dim: 'rgba(246,242,237,0.34)',

  accent: '#FF6B1A',
  accentDeep: '#D94F00',
  accentSoft: 'rgba(255,107,26,0.14)',
  accentLine: 'rgba(255,107,26,0.42)',
  glow: 'rgba(255,107,26,0.38)',
  amber: '#FFB547',
  amberSoft: 'rgba(255,181,71,0.14)',
  onAccent: '#140700',

  // совместимость со старыми экранами
  panel: '#101011',
  card: '#171718',
  key: '#171718',
  keyPressed: '#212123',
  keyBorder: 'rgba(255,255,255,0.07)',
  border: 'rgba(255,255,255,0.07)',
  separator: 'rgba(255,255,255,0.07)',
  talk: '#FF6B1A',
  talkPressed: '#D94F00',
  talking: '#FF6B1A',
  speaking: '#FFB547',
  mute: '#6B2A00',
  danger: '#FF8A5B',
  warning: '#FFB547',
  tallyPgm: '#e00000',
  tallyPrv: '#00875a',
  target: '#171718',
  targetSelected: 'rgba(255,107,26,0.14)',
  reply: 'rgba(255,107,26,0.14)',
};

/** Только шрифты, которые есть на любом Android без подключения файлов. */
export const FONT = {
  title: 'sans-serif-condensed',
  medium: 'sans-serif-medium',
  body: 'sans-serif',
  black: 'sans-serif-black',
  mono: 'monospace',
};
export const MONO = FONT.mono;

export const radius = { sm: 12, md: 18, lg: 26, xl: 34, pill: 999, key: 12, panel: 22 };
