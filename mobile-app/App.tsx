import { useEffect } from 'react';
import { ActivityIndicator, BackHandler, Linking, Platform, SafeAreaView, StyleSheet, View, useColorScheme } from 'react-native';
import { ScreenStack, ScreenStackItem } from 'react-native-screens';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { useAppMode } from './src/app/appMode';
import { useLang } from './src/i18n';
import { session, useSessionStore } from './src/session/store';
import {
  cameraTallyColor,
  TALLY_FRAME_OVERHANG,
  tallyFrameStrokeRadius,
  tallyFrameStrokeWidth,
} from './src/protocol';
import { androidSafeArea } from './src/ui/androidSafeArea';
import { LoginScreen } from './src/ui/LoginScreen';
import { ModeSelectScreen } from './src/ui/ModeSelectScreen';
import { WalkieScreen } from './src/ui/WalkieScreen';
import { OperatorScreen } from './src/ui/OperatorScreen';
import { PausedScreen } from './src/ui/PausedScreen';
import { ProductionPickerScreen } from './src/ui/ProductionPickerScreen';
import { ProfilePickerScreen } from './src/ui/ProfilePickerScreen';
import { closeSessionSheet, useSessionSheetOpen } from './src/ui/sessionSheetState';
import { SessionSheet } from './src/ui/SettingsScreen';
import { settingsPalette, settingsScheme } from './src/ui/settingsTheme';
import { colors } from './src/ui/theme';

function AppInner() {
  const hydrated = useSessionStore((state) => state.hydrated);
  const identity = useSessionStore((state) => state.identity);
  const operatorReady = useSessionStore((state) => state.operatorReady);
  const status = useSessionStore((state) => state.status);
  const paused = useSessionStore((state) => state.paused);
  const addingProfile = useSessionStore((state) => state.addingProfile);
  const profiles = useSessionStore((state) => state.profiles);
  const tallyColor = useSessionStore((state) => cameraTallyColor(state.cameraTally));
  const scheme = useColorScheme();
  const modeHydrated = useAppMode((state) => state.hydrated);
  const modeConfirmed = useAppMode((state) => state.confirmed);
  const appMode = useAppMode((state) => state.mode);

  useEffect(() => {
    if (identity) {
      void activateKeepAwakeAsync('linktalk-session');
      return () => {
        void deactivateKeepAwake('linktalk-session');
      };
    }
    return undefined;
  }, [identity]);

  let screen: Screen;
  if (!modeHydrated) {
    screen = 'loading';
  } else if (!modeConfirmed) {
    // При каждом запуске (если не включено «запомнить выбор») сначала выбираем тип работы.
    screen = 'mode';
  } else if (!hydrated || (status === 'connecting' && !identity && !operatorReady && !addingProfile)) {
    screen = 'loading';
  } else if (identity && operatorReady) {
    screen = appMode === 'walkie' ? 'walkie' : 'operator';
  } else if (identity && status === 'choose-production') {
    screen = 'production';
  } else if (identity) {
    screen = 'loading';
  } else if (paused) {
    screen = 'paused';
  } else if (addingProfile || profiles.length === 0) {
    screen = 'login';
  } else {
    screen = 'profiles';
  }
  // Add profile is pushed over Profiles, so it slides in and swipes back like an iOS stack.
  const loginOverProfiles = screen === 'login' && profiles.length > 0;
  // The session sheet is presented by this stack, not by a React Native Modal (see sessionSheetState).
  const sheetOpen = useSessionSheetOpen((state) => state.open) && (screen === 'operator' || screen === 'walkie');
  const sheetColor = settingsPalette(settingsScheme(scheme)).sheet;
  let pages: Page[] = [screen];
  if (loginOverProfiles) {
    pages = ['profiles', 'login'];
  }

  useEffect(() => {
    if (screen !== 'operator' && screen !== 'walkie') {
      closeSessionSheet();
    }
  }, [screen]);

  // Android back pops Add profile to Profiles, like back inside the session sheet.
  useEffect(() => {
    if (!loginOverProfiles) {
      return undefined;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      session.cancelAddProfile();
      return true;
    });
    return () => subscription.remove();
  }, [loginOverProfiles]);

  return (
    <View style={styles.root}>
      <SafeAreaView style={[styles.safe, androidSafeArea]}>
        <StatusBar style="light" />
        <ScreenStack style={styles.stack}>
          {pages.map((page, index) => {
            // Only pages pushed on another one slide and swipe back; other screens swap in place.
            const pushed = index > 0;
            return (
              <ScreenStackItem
                key={page}
                screenId={page}
                headerConfig={HIDDEN_HEADER}
                stackAnimation={pushed ? 'default' : 'none'}
                gestureEnabled={pushed}
                fullScreenSwipeEnabled
                hideKeyboardOnSwipe
                onDismissed={() => {
                  if (page === 'login') {
                    session.cancelAddProfile();
                  }
                }}
                contentStyle={styles.page}
              >
                <AppScreen screen={page} />
              </ScreenStackItem>
            );
          })}
        </ScreenStack>
      </SafeAreaView>
      {sheetOpen ? (
        // Меню сессии — обычный слой поверх экрана (не нативный экран): так нажатия гарантированно работают.
        <View style={[styles.sheetOverlay, androidSafeArea, { backgroundColor: sheetColor }]}>
          <SessionSheet onClose={closeSessionSheet} />
        </View>
      ) : null}
      {identity && operatorReady && tallyColor && modeConfirmed ? <TallyScreenFrame color={tallyColor} /> : null}
    </View>
  );
}

/**
 * Корень: один раз гидратирует хранилища и подписывается на ссылки. Внутреннее дерево пересоздаётся
 * при смене языка (key), поэтому все `tr()` в экранах пересчитываются; состояние сессии лежит в сторах и не теряется.
 */
export default function App() {
  const lang = useLang((state) => state.lang);
  const langHydrated = useLang((state) => state.hydrated);

  useEffect(() => {
    void useLang.getState().hydrate();
    void session.hydrate();
    void useAppMode.getState().hydrate();
  }, []);

  useEffect(() => {
    const handleUrl = (url: string | null) => {
      if (url) {
        session.handleTalkUrl(url);
      }
    };
    const subscription = Linking.addEventListener('url', (event) => handleUrl(event.url));
    void Linking.getInitialURL().then(handleUrl);
    return () => subscription.remove();
  }, []);

  if (!langHydrated) {
    return <View style={styles.root} />;
  }
  return <AppInner key={lang} />;
}

type Screen = 'loading' | 'mode' | 'walkie' | 'operator' | 'production' | 'paused' | 'login' | 'profiles';

type Page = Screen;

const HIDDEN_HEADER = { hidden: true };

function AppScreen({ screen }: { screen: Screen }) {
  switch (screen) {
    case 'mode':
      return <ModeSelectScreen />;
    case 'walkie':
      return <WalkieScreen />;
    case 'operator':
      return <OperatorScreen />;
    case 'production':
      return <ProductionPickerScreen />;
    case 'paused':
      return <PausedScreen />;
    case 'login':
      return <LoginScreen />;
    case 'profiles':
      return <ProfilePickerScreen />;
    default:
      return <ActivityIndicator color={colors.accent} />;
  }
}

/**
 * One bordered view, no assets. The inner cut is the same curve as a plain
 * 16px / radius-28 border. The view hangs past every screen edge and the container
 * clips it, so its rounded outer corner is never visible: the outer edge is square
 * and painted to the corner of a theoretical square screen.
 */
function TallyScreenFrame({ color }: { color: string }) {
  return (
    <View
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={styles.tallyFrame}
    >
      <View
        style={[
          styles.tallyStroke,
          { borderColor: color },
          Platform.OS === 'ios' ? styles.tallyStrokeContinuous : null,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgBottom,
  },
  safe: {
    flex: 1,
    backgroundColor: colors.bgBottom,
  },
  stack: {
    flex: 1,
  },
  page: {
    backgroundColor: colors.bgBottom,
  },
  sheetOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 30,
  },
  tallyFrame: {
    ...StyleSheet.absoluteFill,
    zIndex: 40,
    overflow: 'hidden',
  },
  tallyStroke: {
    position: 'absolute',
    top: -TALLY_FRAME_OVERHANG,
    left: -TALLY_FRAME_OVERHANG,
    right: -TALLY_FRAME_OVERHANG,
    bottom: -TALLY_FRAME_OVERHANG,
    borderWidth: tallyFrameStrokeWidth(),
    borderRadius: tallyFrameStrokeRadius(),
  },
  tallyStrokeContinuous: {
    borderCurve: 'continuous',
  },
});
