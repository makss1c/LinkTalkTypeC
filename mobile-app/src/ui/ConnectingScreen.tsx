import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { tr } from '../i18n';
import { session, useSessionStore } from '../session/store';
import { PrimaryButton } from './kit';
import { colors, FONT } from './theme';

/** Через сколько показываем кнопку «Вернуться ко входу», если подключение так и не завершилось. */
export const CONNECT_ESCAPE_DELAY_MS = 5000;

/**
 * Экран ожидания вместо чёрного экрана. Если подключение идёт дольше 5 секунд
 * (сервер недоступен, сменился IP), появляется кнопка возврата на экран входа.
 */
export function ConnectingScreen() {
  const serverAddress = useSessionStore((state) => state.serverAddress);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), CONNECT_ESCAPE_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const backToLogin = () => {
    void (async () => {
      try {
        await session.leaveToProfiles();
      } catch {
        // даже если разрыв не удался, всё равно показываем экран входа
      }
      // Экран входа с уже введённым адресом и именем — чтобы поправить IP и войти заново.
      useSessionStore.setState({ addingProfile: true, status: 'idle', error: null });
    })();
  };

  return (
    <View style={styles.screen}>
      <ActivityIndicator color={colors.accent} size="large" />
      <Text style={styles.title}>{tr('Connecting…')}</Text>
      {serverAddress ? <Text style={styles.address}>{serverAddress}</Text> : null}
      {slow ? (
        <View style={styles.slow}>
          <Text style={styles.hint}>{tr('Taking longer than usual. Check the server address and the network.')}</Text>
          <PrimaryButton label={tr('Back to sign in')} onPress={backToLogin} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28, backgroundColor: colors.bg },
  title: { color: colors.text, fontFamily: FONT.medium, fontSize: 18, letterSpacing: 0.4 },
  address: { color: colors.muted, fontFamily: FONT.mono, fontSize: 13 },
  slow: { marginTop: 18, gap: 14, alignSelf: 'stretch', maxWidth: 420 },
  hint: { color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
