import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View, useWindowDimensions } from 'react-native';

import { useAppMode, type AppMode } from '../app/appMode';
import { BRAND } from '../app/brand';
import { tr } from '../i18n';
import { AboutModal } from './AboutModal';
import { BrandMark } from './BrandMark';
import { LangSwitch, Pill, PulseRings } from './kit';
import { TABLET_SHORT_SIDE_MIN } from './layers';
import { colors, FONT, radius } from './theme';

/** Иллюстрация «Рация»: корпус, антенна, кнопка PTT. */
function WalkieGlyph({ on }: { on: boolean }) {
  const c = on ? colors.accent : colors.muted;
  return (
    <View style={glyph.box}>
      <View style={[glyph.antenna, { backgroundColor: c }]} />
      <View style={[glyph.walkie, { borderColor: c }]}>
        <View style={[glyph.speaker, { backgroundColor: c, opacity: 0.35 }]} />
        <View style={[glyph.ptt, { backgroundColor: c }]} />
      </View>
    </View>
  );
}

/** Иллюстрация «Пульт»: сетка клавиш, одна горит. */
function PanelGlyph({ on }: { on: boolean }) {
  const c = on ? colors.accent : colors.muted;
  return (
    <View style={glyph.grid}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <View
          key={i}
          style={[glyph.key, { borderColor: c, opacity: i === 1 ? 1 : 0.55 }, i === 1 && { backgroundColor: c }]}
        />
      ))}
    </View>
  );
}

/** Экран выбора типа работы при запуске. */
export function ModeSelectScreen() {
  const { width, height } = useWindowDimensions();
  const tablet = Math.min(width, height) >= TABLET_SHORT_SIDE_MIN;
  const wide = width > height || tablet;
  const lastMode = useAppMode((state) => state.mode);
  const remembered = useAppMode((state) => state.remember);
  const choose = useAppMode((state) => state.choose);
  const [remember, setRemember] = useState(remembered);
  const [aboutOpen, setAboutOpen] = useState(false);
  const suggested: AppMode = lastMode ?? (tablet ? 'panel' : 'walkie');

  const modes: { id: AppMode; title: string; text: string; tags: string[] }[] = [
    {
      id: 'walkie',
      title: tr('Walkie-talkie'),
      text: tr('Pick a person or group, hold the big button and talk.'),
      tags: [tr('One-hand PTT'), tr('Works with screen off')],
    },
    {
      id: 'panel',
      title: tr('Intercom panel'),
      text: tr('All channels on one board, with volume for each. Made for tablets.'),
      tags: [tr('Channel grid'), tr('Tally'), tr('Layers')],
    },
  ];

  return (
    <View style={styles.screen}>
      <View style={styles.glow} pointerEvents="none">
        <PulseRings active size={260} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.top}>
          <BrandMark size={22} />
          <LangSwitch />
        </View>

        <View style={styles.hero}>
          <Text style={styles.title}>{tr('How will you work today?')}</Text>
          <Text style={styles.subtitle}>{tr('You can switch any time in Session settings.')}</Text>
        </View>

        <View style={[styles.cards, wide && styles.cardsWide]}>
          {modes.map((mode) => {
            const hint = mode.id === suggested;
            return (
              <Pressable
                key={mode.id}
                accessibilityRole="button"
                accessibilityLabel={`${mode.title}. ${mode.text}`}
                onPress={() => choose(mode.id, remember)}
                style={({ pressed }) => [styles.card, wide && styles.cardWide, hint && styles.cardHint, pressed && styles.cardPressed]}
              >
                <View style={styles.cardTop}>
                  {mode.id === 'walkie' ? <WalkieGlyph on={hint} /> : <PanelGlyph on={hint} />}
                  {hint ? <Pill tone="accent">{tr('Suggested')}</Pill> : null}
                </View>
                <Text style={styles.cardTitle}>{mode.title}</Text>
                <Text style={styles.cardText}>{mode.text}</Text>
                <View style={styles.tags}>
                  {mode.tags.map((tag) => (
                    <Pill key={tag}>{tag}</Pill>
                  ))}
                </View>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.remember}>
          <Text style={styles.rememberText}>{tr("Remember my choice and don't ask on launch")}</Text>
          <Switch
            value={remember}
            onValueChange={setRemember}
            trackColor={{ false: colors.s3, true: colors.accentDeep }}
            thumbColor={remember ? colors.accent : colors.muted}
          />
        </View>
      </ScrollView>

      <Pressable accessibilityRole="button" onPress={() => setAboutOpen(true)} style={styles.footer}>
        <Text style={styles.footerText}>
          LinkTalk {BRAND.version} · {BRAND.developer}
        </Text>
        <Text style={styles.footerLink}>{tr('About')}</Text>
      </Pressable>
      <AboutModal visible={aboutOpen} onClose={() => setAboutOpen(false)} />
    </View>
  );
}

const glyph = StyleSheet.create({
  box: { width: 44, height: 64, alignItems: 'center' },
  antenna: { width: 4, height: 12, borderRadius: 2, marginRight: 22 },
  walkie: { width: 40, height: 52, borderRadius: 12, borderWidth: 2.5, alignItems: 'center', paddingTop: 8, gap: 6 },
  speaker: { width: 22, height: 10, borderRadius: 5 },
  ptt: { width: 16, height: 16, borderRadius: 8 },
  grid: { width: 76, height: 56, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  key: { width: 22, height: 25, borderRadius: 7, borderWidth: 2 },
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  glow: { position: 'absolute', top: -60, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', width: 260, height: 260 },
  scroll: { padding: 22, gap: 22, flexGrow: 1, justifyContent: 'center' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hero: { gap: 8, marginTop: 8 },
  title: { color: colors.text, fontFamily: FONT.title, fontWeight: '800', fontSize: 38, lineHeight: 42, letterSpacing: -0.5 },
  subtitle: { color: colors.muted, fontFamily: FONT.body, fontSize: 14 },
  cards: { gap: 14 },
  cardsWide: { flexDirection: 'row' },
  card: { gap: 10, padding: 20, borderRadius: radius.xl, backgroundColor: colors.s1, borderWidth: 1, borderColor: colors.hairline },
  cardWide: { flex: 1 },
  cardHint: { borderColor: colors.accentLine, backgroundColor: '#140D08' },
  cardPressed: { backgroundColor: colors.s3, transform: [{ scale: 0.985 }] },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 },
  cardTitle: { color: colors.text, fontFamily: FONT.title, fontWeight: '800', fontSize: 28, letterSpacing: -0.3 },
  cardText: { color: colors.muted, fontFamily: FONT.body, fontSize: 14, lineHeight: 20 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  remember: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.s1,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  rememberText: { color: colors.text, fontFamily: FONT.body, fontSize: 14, flex: 1 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 22, paddingVertical: 14 },
  footerText: { color: colors.dim, fontFamily: FONT.mono, fontSize: 11 },
  footerLink: { color: colors.accent, fontFamily: FONT.medium, fontSize: 13 },
});
