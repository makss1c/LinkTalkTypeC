import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

/**
 * Режим работы приложения.
 *  - walkie: «Рация» — телефон, один абонент/группа выбран, большая кнопка PTT.
 *  - panel:  «Пульт»  — связная панель (планшет): клавиши всех каналов, слои, громкости.
 */
export type AppMode = 'walkie' | 'panel';

const STORAGE_KEY = 'linktalk.app-mode.v1';

type Stored = { mode: AppMode; remember: boolean };

type AppModeState = {
  hydrated: boolean;
  /** Последний выбранный режим (даже если «запомнить» выключено — подсказка на экране выбора). */
  mode: AppMode | null;
  remember: boolean;
  /** Выбор подтверждён в этом запуске. Пока false — показываем экран выбора режима. */
  confirmed: boolean;
  hydrate: () => Promise<void>;
  choose: (mode: AppMode, remember: boolean) => void;
  /** Быстрое переключение рация ⇄ пульт из настроек, без выхода из сессии. */
  switchMode: (mode: AppMode) => void;
  /** Вернуться на экран выбора режима (сессия остаётся активной). */
  askAgain: () => void;
};

function parse(raw: string | null): Stored | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<Stored>;
    if ((value.mode === 'walkie' || value.mode === 'panel') && typeof value.remember === 'boolean') {
      return { mode: value.mode, remember: value.remember };
    }
  } catch {
    // повреждённое значение — как будто режим не выбирали
  }
  return null;
}

function persist(mode: AppMode, remember: boolean): void {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, remember })).catch(() => undefined);
}

export const useAppMode = create<AppModeState>((set, get) => ({
  hydrated: false,
  mode: null,
  remember: false,
  confirmed: false,
  async hydrate() {
    let stored: Stored | null = null;
    try {
      stored = parse(await AsyncStorage.getItem(STORAGE_KEY));
    } catch {
      stored = null;
    }
    set({
      hydrated: true,
      mode: stored?.mode ?? null,
      remember: stored?.remember ?? false,
      // «Запомнить выбор» пропускает экран выбора при следующем запуске.
      confirmed: Boolean(stored?.remember),
    });
  },
  choose(mode, remember) {
    set({ mode, remember, confirmed: true });
    persist(mode, remember);
  },
  switchMode(mode) {
    set({ mode, confirmed: true });
    persist(mode, get().remember);
  },
  askAgain() {
    set({ confirmed: false });
  },
}));
