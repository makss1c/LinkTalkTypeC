import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BRAND } from '../app/brand';
import { tr } from '../i18n';
import { BrandMark, EngravedLabel } from './BrandMark';
import { LangSwitch, PrimaryButton } from './kit';
import { colors, FONT, radius } from './theme';

type Props = { visible: boolean; onClose: () => void };

function openLink(url: string): void {
  void Linking.openURL(url).catch(() => undefined);
}

function LinkRow({ label, value, url }: { label: string; value: string; url: string }) {
  return (
    <Pressable accessibilityRole="link" onPress={() => openLink(url)} style={styles.linkRow}>
      <Text style={styles.linkLabel}>{label}</Text>
      <Text style={styles.linkValue} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}

/** «О программе»: разработчик, контакты, происхождение кода, язык. */
export function AboutModal({ visible, onClose }: Props) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            <View style={styles.top}>
              <BrandMark size={26} />
              <LangSwitch />
            </View>
            <Text style={styles.version}>
              {tr('Version')} {BRAND.version}
            </Text>
            <Text style={styles.tagline}>{tr('Digital intercom system')}</Text>

            <EngravedLabel>{tr('Developer')}</EngravedLabel>
            <View style={styles.group}>
              <Text style={styles.dev}>{BRAND.developer}</Text>
              <LinkRow label="Telegram" value={BRAND.telegramHandle} url={BRAND.telegramUrl} />
              <LinkRow label="E-mail" value={BRAND.email} url={BRAND.emailUrl} />
            </View>

            <EngravedLabel>{tr('Based on')}</EngravedLabel>
            <View style={styles.group}>
              <Text style={styles.text}>
                {tr('LinkTalk is a derivative work based on the open-source project {name} by {author}.', {
                  name: BRAND.upstreamName,
                  author: BRAND.upstreamAuthor,
                })}
              </Text>
              <Text style={styles.dim}>
                {BRAND.upstreamContributors.join(', ')} · {BRAND.license}
              </Text>
              <LinkRow label="GitHub" value="thepoison606/talktome" url={BRAND.upstreamUrl} />
            </View>
            <Text style={styles.copy}>© 2026 {BRAND.developer} · Apache License 2.0</Text>
          </ScrollView>
          <View style={styles.footer}>
            <PrimaryButton label={tr('Close')} onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '90%',
    backgroundColor: colors.s1,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.hairline,
    overflow: 'hidden',
  },
  grabber: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: colors.s3, marginTop: 10 },
  body: { padding: 22, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  version: { color: colors.accent, fontFamily: FONT.mono, fontSize: 12, marginTop: 6 },
  tagline: { color: colors.muted, fontFamily: FONT.body, fontSize: 14, marginBottom: 8 },
  group: { gap: 8, padding: 16, borderRadius: radius.md, backgroundColor: colors.s2, borderWidth: 1, borderColor: colors.hairline },
  dev: { color: colors.text, fontFamily: FONT.title, fontSize: 28, fontWeight: '700' },
  linkRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
    backgroundColor: colors.s3,
  },
  linkLabel: { color: colors.dim, fontFamily: FONT.medium, fontSize: 12, letterSpacing: 1 },
  linkValue: { color: colors.accent, fontFamily: FONT.medium, fontSize: 15, flexShrink: 1 },
  text: { color: colors.text, fontFamily: FONT.body, fontSize: 14, lineHeight: 21 },
  dim: { color: colors.dim, fontFamily: FONT.mono, fontSize: 11 },
  copy: { color: colors.dim, fontFamily: FONT.mono, fontSize: 10, textAlign: 'center', marginTop: 6 },
  footer: { padding: 16, paddingTop: 8 },
});
