import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { tr } from '../i18n';
import { talkTargetIdentity, visibleProductionName, type TalkTarget } from '../protocol';
import { connectionHealthFromSession, type ConnectionHealthKind } from '../session/connectionHealth';
import { mainButtonCandidates, mainButtonStorageKey, resolveMainButton } from '../session/mainButton';
import { session, useSessionStore } from '../session/store';
import { slideToLockHint } from '../talk/slideToLock';
import { AudioRouteButton } from './AudioRouteButton';
import { BrandMark } from './BrandMark';
import { HoldToTalk } from './HoldToTalk';
import { LockIcon, WalkieTalkieIcon } from './icons';
import { Equalizer, Monogram, Pill, PulseRings } from './kit';
import { openSessionSheet } from './sessionSheetState';
import { colors, FONT, radius } from './theme';

const GAP = 14;

const HEALTH_COLOR: Record<ConnectionHealthKind, string> = {
  idle: colors.dim,
  connecting: colors.amber,
  connected: colors.accent,
  warning: colors.amber,
  failed: '#FF4B2B',
};

type Card = { key: string; identity: string; target: TalkTarget | null };

/**
 * «Рация». Абоненты — это карусель: листайте, чтобы выбрать, с кем говорить.
 * Выбранная карточка — «главная кнопка» сессии, поэтому на неё же работает аппаратная PTT-кнопка.
 */
export function WalkieScreen() {
  const store = useSessionStore();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const connection = connectionHealthFromSession(store);

  const storageKey = mainButtonStorageKey(store.activeProfileId, store.productionId);
  const stored = store.mainButtonTargets[storageKey];
  const main = resolveMainButton({
    storedIdentity: stored,
    targets: store.targets,
    replyTarget: store.replyTarget,
    canTalk: (target) => session.canTalkTo(target),
  });
  const mainTarget = main.target;
  const mainKey = mainTarget ? talkTargetIdentity(mainTarget) : '';
  const mainTalking = Boolean(mainTarget && store.talking && store.talkingTargetKeys.includes(mainKey));
  const mainLocked = Boolean(mainKey && store.lockedTargetKeys.includes(mainKey));

  const candidates = useMemo(
    () => mainButtonCandidates(store.targets, store.identity?.id ?? null),
    [store.targets, store.identity?.id],
  );
  const cards: Card[] = useMemo(
    () => [
      { key: 'reply', identity: '', target: null },
      ...candidates.map((target) => ({ key: talkTargetIdentity(target), identity: talkTargetIdentity(target), target })),
    ],
    [candidates],
  );
  const foundIndex = stored ? cards.findIndex((card) => card.identity === stored) : 0;
  const selectedIndex = foundIndex < 0 ? 0 : foundIndex;

  const isOnline = (target: TalkTarget): boolean =>
    target.type !== 'user' || store.peers.some((peer) => peer.kind === 'user' && peer.userId === target.id);

  // Первый вход: сразу выбираем первого абонента в сети, чтобы PTT был готов.
  const autoSelected = useRef<string | null>(null);
  useEffect(() => {
    if (!store.operatorReady || stored !== undefined || candidates.length === 0) {
      return;
    }
    if (autoSelected.current === storageKey) {
      return;
    }
    autoSelected.current = storageKey;
    const first = candidates.find((target) => isOnline(target)) ?? candidates[0];
    session.setMainButtonTarget(talkTargetIdentity(first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.operatorReady, stored, storageKey, candidates.length]);

  // Карусель
  const [listWidth, setListWidth] = useState(0);
  const listRef = useRef<FlatList<Card>>(null);
  const lastScrolled = useRef(-1);
  const pttSize = landscape ? Math.min(height - 120, 210) : Math.min(width * 0.5, 190);
  const areaWidth = landscape ? Math.max(0, width - pttSize - 64) : width;
  const itemWidth = Math.min(Math.max(areaWidth * 0.62, 190), 300);
  const step = itemWidth + GAP;
  const sidePad = Math.max(0, (listWidth - itemWidth) / 2);

  useEffect(() => {
    if (listWidth <= 0 || lastScrolled.current === selectedIndex) {
      return;
    }
    lastScrolled.current = selectedIndex;
    listRef.current?.scrollToOffset({ offset: selectedIndex * step, animated: true });
  }, [selectedIndex, step, listWidth]);

  const choose = (index: number) => {
    const clamped = Math.max(0, Math.min(cards.length - 1, index));
    if (clamped === selectedIndex) {
      return;
    }
    lastScrolled.current = clamped;
    listRef.current?.scrollToOffset({ offset: clamped * step, animated: true });
    session.setMainButtonTarget(cards[clamped].identity);
  };

  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    choose(Math.round(event.nativeEvent.contentOffset.x / step));
  };

  const speakers = useMemo(() => {
    const names = store.incoming.addressedNow.map((entry) => entry.fromName?.trim() || tr('Someone'));
    return [...new Set(names)];
  }, [store.incoming.addressedNow]);
  const incoming = speakers.length > 0;

  const [allOpen, setAllOpen] = useState(false);

  const notice =
    connection.kind === 'warning' || connection.kind === 'failed' ? tr(connection.label) : tr(store.audioNotice);
  const production = visibleProductionName(store.productionName);

  const statusText = mainTalking
    ? mainLocked
      ? tr('On air · locked')
      : tr('On air')
    : !mainTarget
      ? main.mode === 'reply'
        ? tr('Nobody has called you yet')
        : tr('Pick who to talk to')
      : isOnline(mainTarget)
        ? tr('Ready')
        : tr('Offline — they will not hear you');

  const header = (
    <View style={styles.header}>
      <BrandMark size={18} />
      <View style={styles.headerRight}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${tr('Session')}, ${tr(connection.label)}`}
          onPress={() => openSessionSheet()}
          style={styles.statusPill}
        >
          <View style={[styles.statusDot, { backgroundColor: HEALTH_COLOR[connection.kind] }]} />
          <Text style={styles.statusText} numberOfLines={1}>
            {production ?? tr(connection.shortLabel)}
          </Text>
        </Pressable>
        <AudioRouteButton />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr('Session settings')}
          onPress={() => openSessionSheet()}
          style={styles.avatar}
        >
          <Text style={styles.avatarText}>{(store.identity?.name ?? '?').slice(0, 1).toUpperCase()}</Text>
        </Pressable>
      </View>
    </View>
  );

  const banner = incoming ? (
    <View style={styles.incoming}>
      <Equalizer active />
      <View style={styles.incomingText}>
        <Text style={styles.incomingLabel}>{tr('Calling you')}</Text>
        <Text style={styles.incomingName} numberOfLines={1}>
          {speakers.join(' · ')}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          choose(0);
          session.setMainButtonTarget('');
        }}
        style={styles.replyChip}
      >
        <Text style={styles.replyChipText}>{tr('Reply')}</Text>
      </Pressable>
    </View>
  ) : null;

  const carousel = (
    <View style={styles.carouselWrap} onLayout={(event) => setListWidth(event.nativeEvent.layout.width)}>
      <FlatList
        ref={listRef}
        data={cards}
        horizontal
        keyExtractor={(card) => card.key}
        showsHorizontalScrollIndicator={false}
        snapToInterval={step}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: sidePad, gap: GAP, alignItems: 'center' }}
        onMomentumScrollEnd={onScrollEnd}
        extraData={`${selectedIndex}-${store.peers.length}-${mainTalking}`}
        renderItem={({ item, index }) => {
          const selected = index === selectedIndex;
          const target = item.target;
          const label = target ? target.label : store.replyTarget ? store.replyTarget.label : tr('Reply');
          const online = target ? isOnline(target) : Boolean(store.replyTarget);
          const group = target?.type === 'conference';
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={target ? target.label : tr('Reply')}
              onPress={() => choose(index)}
              style={[
                styles.card,
                { width: itemWidth },
                selected ? styles.cardSelected : styles.cardIdle,
                selected && mainTalking && styles.cardTalking,
              ]}
            >
              <Monogram
                label={target ? label : '↩'}
                size={selected ? 92 : 72}
                online={online}
                talking={selected && mainTalking}
                group={group}
              />
              <Text style={styles.cardName} numberOfLines={2}>
                {target ? label : tr('Reply')}
              </Text>
              <Text style={styles.cardMeta} numberOfLines={1}>
                {target
                  ? group
                    ? tr('Group')
                    : online
                      ? tr('Online')
                      : tr('Offline')
                  : store.replyTarget
                    ? store.replyTarget.label
                    : tr('Whoever called you last')}
              </Text>
            </Pressable>
          );
        }}
      />
      <View style={styles.dots}>
        {cards.length <= 9
          ? cards.map((card, index) => <View key={card.key} style={[styles.dot, index === selectedIndex && styles.dotOn]} />)
          : (
            <Text style={styles.counter}>
              {selectedIndex + 1} / {cards.length}
            </Text>
          )}
      </View>
    </View>
  );

  const ptt = (
    <View style={styles.pttColumn}>
      <View style={[styles.pttWrap, { width: pttSize, height: pttSize }]}>
        <PulseRings active={mainTalking} size={pttSize} />
        <HoldToTalk
          accessibilityLabel={mainTarget ? `${tr('Talk to')} ${mainTarget.label}` : tr('Pick who to talk to')}
          disabled={!mainTarget}
          locked={mainLocked}
          leftHanded={store.leftHanded}
          onPress={() => {
            Vibration.vibrate(18);
            void session.pressMainButton();
          }}
          onLock={() => {
            Vibration.vibrate([0, 25, 40, 25]);
            void session.lockMainButton();
          }}
          onRelease={() => void session.releaseTalk()}
          style={[
            styles.ptt,
            { width: pttSize, height: pttSize, borderRadius: pttSize / 2 },
            mainTalking && styles.pttActive,
            !mainTarget && styles.pttDisabled,
          ]}
        >
          {mainLocked ? (
            <LockIcon color={mainTalking ? colors.onAccent : colors.text} size={40} />
          ) : (
            <WalkieTalkieIcon color={mainTalking ? colors.onAccent : colors.accent} size={46} />
          )}
          <Text style={[styles.pttText, mainTalking && { color: colors.onAccent }]}>
            {mainTalking ? tr('On air') : tr('Hold to talk')}
          </Text>
        </HoldToTalk>
      </View>
      <Text style={styles.pttStatus} numberOfLines={2}>
        {statusText}
      </Text>
      {mainTarget && !mainTalking ? <Text style={styles.pttHint}>{tr(slideToLockHint(store.leftHanded))}</Text> : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      {header}
      {banner}
      {notice ? <Text style={styles.warn}>{notice}</Text> : null}
      {store.error ? <Text style={styles.warn}>{tr(store.error)}</Text> : null}

      <View style={landscape ? styles.bodyLandscape : styles.body}>
        <View style={styles.carouselArea}>
          {carousel}
          <Pressable accessibilityRole="button" onPress={() => setAllOpen(true)} style={styles.allButton}>
            <Text style={styles.allText}>{tr('All contacts')} · {candidates.length}</Text>
          </Pressable>
        </View>
        {ptt}
      </View>

      <Modal visible={allOpen} animationType="slide" transparent onRequestClose={() => setAllOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <View style={styles.grabber} />
            <Text style={styles.modalTitle}>{tr('All contacts')}</Text>
            <FlatList
              data={cards}
              keyExtractor={(card) => card.key}
              renderItem={({ item, index }) => {
                const target = item.target;
                const online = target ? isOnline(target) : Boolean(store.replyTarget);
                return (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      choose(index);
                      setAllOpen(false);
                    }}
                    style={[styles.row, index === selectedIndex && styles.rowOn]}
                  >
                    <Monogram label={target ? target.label : '↩'} size={42} online={online} group={target?.type === 'conference'} />
                    <View style={styles.rowText}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {target ? target.label : tr('Reply')}
                      </Text>
                      <Text style={styles.rowMeta}>
                        {target ? (target.type === 'conference' ? tr('Group') : online ? tr('Online') : tr('Offline')) : tr('Whoever called you last')}
                      </Text>
                    </View>
                    {index === selectedIndex ? <Pill tone="accent">{tr('Selected')}</Pill> : null}
                  </Pressable>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 12, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  statusPill: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 38,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.s1,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: colors.text, fontFamily: FONT.medium, fontSize: 13, flexShrink: 1 },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentLine, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.accent, fontFamily: FONT.black, fontSize: 16 },
  warn: { color: colors.danger, fontFamily: FONT.body, fontSize: 12, marginBottom: 6 },
  incoming: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    marginBottom: 10,
    borderRadius: radius.lg,
    backgroundColor: colors.amberSoft,
    borderWidth: 1,
    borderColor: 'rgba(255,181,71,0.4)',
  },
  incomingText: { flex: 1, minWidth: 0 },
  incomingLabel: { color: colors.amber, fontFamily: FONT.medium, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' },
  incomingName: { color: colors.text, fontFamily: FONT.title, fontWeight: '700', fontSize: 20 },
  replyChip: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.pill, backgroundColor: colors.amber },
  replyChipText: { color: colors.onAccent, fontFamily: FONT.medium, fontSize: 14 },
  body: { flex: 1, minHeight: 0, justifyContent: 'space-between' },
  bodyLandscape: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 20, minHeight: 0 },
  carouselArea: { flex: 1, minWidth: 0, gap: 10, justifyContent: 'center' },
  carouselWrap: { gap: 12 },
  card: { alignItems: 'center', gap: 8, paddingVertical: 22, paddingHorizontal: 14, borderRadius: radius.xl, borderWidth: 1 },
  cardIdle: { backgroundColor: colors.s1, borderColor: colors.hairline, opacity: 0.55, transform: [{ scale: 0.92 }] },
  cardSelected: { backgroundColor: colors.s2, borderColor: colors.accentLine },
  cardTalking: { backgroundColor: colors.accentSoft, borderColor: colors.accent, shadowColor: colors.accent, shadowOpacity: 0.6, shadowRadius: 24, elevation: 12 },
  cardName: { color: colors.text, fontFamily: FONT.title, fontWeight: '800', fontSize: 26, textAlign: 'center', letterSpacing: -0.3 },
  cardMeta: { color: colors.muted, fontFamily: FONT.body, fontSize: 13 },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, minHeight: 10 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.s3 },
  dotOn: { width: 18, backgroundColor: colors.accent },
  counter: { color: colors.dim, fontFamily: FONT.mono, fontSize: 12 },
  allButton: { alignSelf: 'center', paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.s1, borderWidth: 1, borderColor: colors.hairline },
  allText: { color: colors.muted, fontFamily: FONT.medium, fontSize: 12 },
  pttColumn: { alignItems: 'center', gap: 8, paddingVertical: 6 },
  pttWrap: { alignItems: 'center', justifyContent: 'center' },
  ptt: {
    gap: 6,
    backgroundColor: colors.s1,
    borderWidth: 3,
    borderColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 8,
  },
  pttActive: { backgroundColor: colors.accent, borderColor: '#FFC08F' },
  pttDisabled: { borderColor: colors.s3, shadowOpacity: 0, elevation: 0 },
  pttText: { color: colors.text, fontFamily: FONT.medium, fontSize: 15, letterSpacing: 0.4 },
  pttStatus: { color: colors.text, fontFamily: FONT.medium, fontSize: 14, textAlign: 'center' },
  pttHint: { color: colors.dim, fontFamily: FONT.body, fontSize: 12 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  modalSheet: { maxHeight: '80%', backgroundColor: colors.s1, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderWidth: 1, borderColor: colors.hairline, paddingBottom: 12 },
  grabber: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: colors.s3, marginTop: 10 },
  modalTitle: { color: colors.text, fontFamily: FONT.title, fontWeight: '800', fontSize: 24, padding: 20, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 12 },
  rowOn: { backgroundColor: colors.accentSoft },
  rowText: { flex: 1, minWidth: 0 },
  rowName: { color: colors.text, fontFamily: FONT.medium, fontSize: 16 },
  rowMeta: { color: colors.muted, fontFamily: FONT.body, fontSize: 12 },
});
