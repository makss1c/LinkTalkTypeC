import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import { RU } from './ru';

/**
 * Два языка интерфейса: английский (ключи) и русский (словарь RU).
 * Ключ — это английская фраза; если перевода нет, показывается она же.
 * `tr()` читает текущий язык напрямую, а корень приложения пересоздаётся при смене языка (см. App.tsx).
 */
export type Lang = 'en' | 'ru';

const STORAGE_KEY = 'linktalk.lang.v1';

function deviceLang(): Lang {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    return locale.toLowerCase().startsWith('ru') ? 'ru' : 'en';
  } catch {
    return 'en';
  }
}

type LangState = {
  lang: Lang;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setLang: (lang: Lang) => void;
};

export const useLang = create<LangState>((set) => ({
  lang: deviceLang(),
  hydrated: false,
  async hydrate() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw === 'en' || raw === 'ru') {
        set({ lang: raw, hydrated: true });
        return;
      }
    } catch {
      // используем язык устройства
    }
    set({ hydrated: true });
  },
  setLang(lang) {
    set({ lang });
    void AsyncStorage.setItem(STORAGE_KEY, lang).catch(() => undefined);
  },
}));

export function currentLang(): Lang {
  return useLang.getState().lang;
}

/** Перевод фразы. Параметры подставляются вместо `{name}`. */
export function tr(text: string, params?: Record<string, string | number>): string {
  const base = currentLang() === 'ru' ? (RU[text] ?? text) : text;
  if (!params) {
    return base;
  }
  return base.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] === undefined ? match : String(params[name]),
  );
}
