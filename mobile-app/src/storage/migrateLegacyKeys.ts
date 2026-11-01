import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

/**
 * Ключи хранилища назывались `talktome.*`, теперь `linktalk.*`.
 * При запуске переносим значения со старых ключей на новые (если новых ещё нет) и удаляем старые,
 * чтобы сохранённые профили, пароли, закреплённые сертификаты и настройки не потерялись после обновления.
 */
export const ASYNC_KEY_NAMES = [
  'ble-button',
  'operator-audio',
  'conference-listen',
  'saved-profiles',
  'target-audio-preferences',
] as const;

export const SECURE_KEY_NAMES = ['profile-passwords', 'tls-pins', 'talk-link-token'] as const;

export const legacyKey = (name: string): string => `talktome.${name}`;
export const currentKey = (name: string): string => `linktalk.${name}`;

export async function migrateLegacyStorage(): Promise<void> {
  for (const name of ASYNC_KEY_NAMES) {
    try {
      const old = await AsyncStorage.getItem(legacyKey(name));
      if (old === null) continue;
      if ((await AsyncStorage.getItem(currentKey(name))) === null) {
        await AsyncStorage.setItem(currentKey(name), old);
      }
      await AsyncStorage.removeItem(legacyKey(name));
    } catch {
      // не удалось перенести один ключ — остальные всё равно пробуем
    }
  }
  for (const name of SECURE_KEY_NAMES) {
    try {
      const old = await SecureStore.getItemAsync(legacyKey(name));
      if (old === null) continue;
      if ((await SecureStore.getItemAsync(currentKey(name))) === null) {
        await SecureStore.setItemAsync(currentKey(name), old);
      }
      await SecureStore.deleteItemAsync(legacyKey(name));
    } catch {
      // см. выше
    }
  }
}
