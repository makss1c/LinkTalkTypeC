import { Image, StyleSheet, Text, View } from 'react-native';

import { colors, FONT } from './theme';

/** Логотип: знак + «LinkTalk», «Talk» оранжевым. */
export function BrandMark({ size = 22, showMark = true }: { size?: number; showMark?: boolean }) {
  return (
    <View style={styles.row} accessibilityRole="header" accessibilityLabel="LinkTalk">
      {showMark ? (
        <Image
          source={require('../../assets/linktalk-mark.png')}
          style={{ width: size * 1.5, height: size * 1.5, borderRadius: size * 0.42 }}
        />
      ) : null}
      <Text style={[styles.word, { fontSize: size }]}>
        Link<Text style={styles.accent}>Talk</Text>
      </Text>
    </View>
  );
}

/** Маленькая надпись-«рубрика» над блоком. */
export function EngravedLabel({ children }: { children: string }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  word: { color: colors.text, fontFamily: FONT.black, letterSpacing: -0.3 },
  accent: { color: colors.accent },
  eyebrow: {
    color: colors.dim,
    fontFamily: FONT.medium,
    fontSize: 11,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
});
