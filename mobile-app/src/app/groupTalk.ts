import { create } from 'zustand';

/**
 * Групповой вызов в режиме «Пульт»: выбираем несколько абонентов/групп и говорим им всем
 * одной кнопкой. Выбор — только состояние экрана, на сервер ничего не сохраняется.
 */
type GroupTalkState = {
  active: boolean;
  keys: string[];
  setActive: (active: boolean) => void;
  toggleKey: (key: string) => void;
  setKeys: (keys: string[]) => void;
  clear: () => void;
};

export const useGroupTalk = create<GroupTalkState>((set) => ({
  active: false,
  keys: [],
  setActive: (active) => set(active ? { active } : { active, keys: [] }),
  toggleKey: (key) =>
    set((state) => ({ keys: state.keys.includes(key) ? state.keys.filter((item) => item !== key) : [...state.keys, key] })),
  setKeys: (keys) => set({ keys }),
  clear: () => set({ keys: [] }),
}));
