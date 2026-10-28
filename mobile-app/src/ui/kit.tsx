import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { tr, useLang, type Lang } from '../i18n';
import { colors, FONT, radius } from './theme';

/** Расходящиеся кольца вокруг кнопки/аватара, пока идёт передача или входящий вызов. */
export function PulseRings({ active, size, color = colors.accent }: { active: boolean; size: number; color?: string }) {
  const values = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (!active) {
      values.forEach((value) => value.setValue(0));
      return undefined;
    }
    const loops = values.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 520),
          Animated.timing(value, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(value, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [active, values]);
  return (
    <View pointerEvents="none" style={[styles.ringsHost, { width: size, height: size }]}>
      {values.map((value, index) => (
        <Animated.View
          key={index}
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 2,
            borderColor: color,
            opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
            transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, 1.85] }) }],
          }}
        />
      ))}
    </View>
  );
}

/** Анимированный «эквалайзер» — показывает, что кто-то говорит. */
export function Equalizer({ active, color = colors.amber, height = 22 }: { active: boolean; color?: string; height?: number }) {
  const bars = useRef([0.5, 0.9, 0.6, 1, 0.7].map((base) => ({ base, value: new Animated.Value(0.25) }))).current;
  useEffect(() => {
    if (!active) {
      bars.forEach((bar) => bar.value.setValue(0.25));
      return undefined;
    }
    const loops = bars.map((bar, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(bar.value, { toValue: bar.base, duration: 260 + index * 70, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(bar.value, { toValue: 0.2, duration: 300 + index * 50, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [active, bars]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height }}>
      {bars.map((bar, index) => (
        <Animated.View
          key={index}
          style={{ width: 4, height, borderRadius: 2, backgroundColor: color, transform: [{ scaleY: bar.value }] }}
        />
      ))}
    </View>
  );
}

const TINTS = ['#FF6B1A', '#FF8A3D', '#E8590C', '#FFA351', '#C2410C'];

function tintFor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash * 31 + label.charCodeAt(i)) % 997;
  }
  return TINTS[hash % TINTS.length];
}

export function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  if (parts.length === 1) {
    return Array.from(parts[0]).slice(0, 2).join('').toUpperCase();
  }
  return (Array.from(parts[0])[0] + Array.from(parts[1])[0]).toUpperCase();
}

/** Монограмма абонента: скруглённый квадрат с инициалами. */
export function Monogram({
  label,
  size = 48,
  online = true,
  talking = false,
  group = false,
}: {
  label: string;
  size?: number;
  online?: boolean;
  talking?: boolean;
  group?: boolean;
}) {
  const tint = tintFor(label);
  const bg = talking ? colors.accent : online ? colors.accentSoft : colors.s3;
  const fg = talking ? colors.onAccent : online ? tint : colors.dim;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: group ? size * 0.5 : size * 0.34,
        backgroundColor: bg,
        borderWidth: 1,
        borderColor: talking ? colors.accent : online ? colors.accentLine : colors.hairline,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: fg, fontFamily: FONT.black, fontSize: size * 0.36, letterSpacing: 0.5 }}>
        {group ? '◎' : initialsOf(label)}
      </Text>
    </View>
  );
}

export function Surface({ children, style, accent = false }: { children: ReactNode; style?: StyleProp<ViewStyle>; accent?: boolean }) {
  return <View style={[styles.surface, accent && styles.surfaceAccent, style]}>{children}</View>;
}

export function Pill({
  children,
  tone = 'neutral',
  style,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'amber';
  style?: StyleProp<ViewStyle>;
}) {
  const color = tone === 'accent' ? colors.accent : tone === 'amber' ? colors.amber : colors.muted;
  const bg = tone === 'accent' ? colors.accentSoft : tone === 'amber' ? colors.amberSoft : colors.s2;
  return (
    <View style={[styles.pill, { backgroundColor: bg }, style]}>
      <Text style={[styles.pillText, { color }]} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  style,
  textStyle,
  ghost = false,
}: {
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  ghost?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, ghost ? styles.buttonGhost : styles.buttonSolid, pressed && { opacity: 0.8 }, style]}
    >
      <Text style={[styles.buttonText, ghost && { color: colors.text }, textStyle]}>{label}</Text>
    </Pressable>
  );
}

/** Переключатель языка EN | RU. Работает везде: на экране выбора режима, в настройках, в «О программе». */
export function LangSwitch({ style }: { style?: StyleProp<ViewStyle> }) {
  const lang = useLang((state) => state.lang);
  const setLang = useLang((state) => state.setLang);
  const items: { id: Lang; label: string }[] = [
    { id: 'en', label: 'EN' },
    { id: 'ru', label: 'RU' },
  ];
  return (
    <View style={[styles.lang, style]} accessibilityRole="radiogroup" accessibilityLabel={tr('Language')}>
      {items.map((item) => {
        const on = item.id === lang;
        return (
          <Pressable
            key={item.id}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => setLang(item.id)}
            style={[styles.langItem, on && styles.langItemOn]}
          >
            <Text style={[styles.langText, on && styles.langTextOn]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  ringsHost: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  surface: {
    backgroundColor: colors.s1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  surfaceAccent: { backgroundColor: colors.accentSoft, borderColor: colors.accentLine },
  pill: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill },
  pillText: { fontFamily: FONT.medium, fontSize: 12, letterSpacing: 0.2 },
  button: { minHeight: 52, borderRadius: radius.pill, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  buttonSolid: { backgroundColor: colors.accent },
  buttonGhost: { backgroundColor: colors.s2, borderWidth: 1, borderColor: colors.hairlineStrong },
  buttonText: { color: colors.onAccent, fontFamily: FONT.medium, fontSize: 16, letterSpacing: 0.3 },
  lang: { flexDirection: 'row', padding: 3, borderRadius: radius.pill, backgroundColor: colors.s2, borderWidth: 1, borderColor: colors.hairline },
  langItem: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill },
  langItemOn: { backgroundColor: colors.accent },
  langText: { color: colors.muted, fontFamily: FONT.medium, fontSize: 12, letterSpacing: 1 },
  langTextOn: { color: colors.onAccent },
});
