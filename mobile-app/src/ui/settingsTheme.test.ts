import { describe, expect, it } from 'vitest';

import { settingsPalette, settingsScheme } from './settingsTheme';

describe('settings theme', () => {
  it('is always the black and orange dark palette', () => {
    expect(settingsScheme('dark')).toBe('dark');
    expect(settingsScheme('light')).toBe('dark');
    expect(settingsPalette('light').sheet).toBe('#060606');
    expect(settingsPalette('dark').card).toBe('#101011');
    expect(settingsPalette('dark').link).toBe('#FF6B1A');
  });
});
