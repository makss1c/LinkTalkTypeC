import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import {
  cameraTallyColor,
  cameraTallyLabel,
  visibleProductionName,
  talkTargetIdentity,
  type TalkTarget,
} from '../protocol';
import { missingAccessoryNotice } from '../ble/bindings';
import { connectionHealthFromSession } from '../session/connectionHealth';
import { mainButtonStorageKey, resolveMainButton } from '../session/mainButton';
import { session, useSessionStore } from '../session/store';
import { slideToLockHint } from '../talk/slideToLock';
import { ConferenceMembersModal } from './ConferenceMembersModal';
import { AudioRouteButton } from './AudioRouteButton';
import { ConnectionStatusBadge } from './ConnectionStatusBadge';
import { ChevronIcon, LockIcon, ReplyArrowIcon, WalkieTalkieIcon } from './icons';
import { HoldToTalk } from './HoldToTalk';
import { MultiTouchRoot } from './MultiTouch';
import {
  chunkTargets,
  COLLAPSED_HEADER_HEIGHT,
  estimateTargetListHeight,
  isCompactOperatorScreen,
  isTabletOperatorScreen,
  operatorLayout,
  shouldOfferHeaderCollapse,
  targetLayerCount,
  visibleTargets,
} from './layers';
import { openSessionSheet } from './sessionSheetState';
import { TargetRow } from './TargetRow';
import { tr } from '../i18n';
import { colors, FONT, radius } from './theme';

/** Launch and short dropouts reconnect on their own; only warn when an accessory stays away. */
const ACCESSORY_NOTICE_DELAY_MS = 5000;

function useDelayedNotice(text: string | null, delayMs: number): string | null {
  const [shown, setShown] = useState(false);
  const active = text != null;
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return shown ? text : null;
}

function OperatorScreenInner() {
  const store = useSessionStore();
  const window = useWindowDimensions();
  const [measured, setMeasured] = useState({ width: 0, height: 0 });
  const width = measured.width || window.width;
  const height = measured.height || window.height;
  const compact = isCompactOperatorScreen(width, height);
  const tablet = isTabletOperatorScreen(width, height);
  const [layerIndex, setLayerIndex] = useState(0);
  const [conferenceTarget, setConferenceTarget] = useState<TalkTarget | null>(null);
  const [headerCollapsed, setHeaderCollapsed] = useState(compact);
  const [headerHeight, setHeaderHeight] = useState(96);
  const [listHeight, setListHeight] = useState(0);
  const compactRef = useRef(compact);
  const reply = store.replyTarget;
  const mainButton = resolveMainButton({
    storedIdentity: store.mainButtonTargets[mainButtonStorageKey(store.activeProfileId, store.productionId)],
    targets: store.targets,
    replyTarget: reply,
    canTalk: (target) => session.canTalkTo(target),
  });
  const availableHeight = listHeight || estimateTargetListHeight(width, height, headerCollapsed);
  const layout = operatorLayout({
    width,
    height,
    availableHeight,
    headerCollapsed,
  });
  const replyBeside = layout.replyBeside;
  const layers = targetLayerCount(store.targets.length, width, height, availableHeight, headerCollapsed);
  const safeLayerIndex = Math.min(layerIndex, layers - 1);
  const page = visibleTargets(store.targets, safeLayerIndex, width, height, availableHeight, headerCollapsed);
  const grid = chunkTargets(page, layout.columns);
  const offerCollapse =
    headerCollapsed ||
    shouldOfferHeaderCollapse({
      rows: layout.rows,
      availableHeight,
      headerHeight,
      maxRows: layout.maxRows,
      compact,
    });

  useEffect(() => {
    setLayerIndex(0);
  }, [store.productionId, store.targets.length, layout.columns, replyBeside]);

  useEffect(() => {
    if (compactRef.current === compact) {
      return;
    }
    compactRef.current = compact;
    setHeaderCollapsed(compact);
  }, [compact]);

  const collapseHeader = () => {
    setHeaderCollapsed(true);
  };
  const expandHeader = () => {
    setHeaderCollapsed(false);
  };

  const mainTarget = mainButton.target;
  const mainKey = mainTarget ? talkTargetIdentity(mainTarget) : '';
  const mainTalking = Boolean(mainTarget && store.talking && store.talkingTargetKeys.includes(mainKey));

  const productionLabel = visibleProductionName(store.productionName);
  const connection = connectionHealthFromSession(store);
  const mediaNotice =
    connection.kind === 'warning' || connection.kind === 'failed' ? tr(connection.label) : tr(store.audioNotice);
  const accessoryNotice = useDelayedNotice(
    missingAccessoryNotice(store.bleBindings, store.bleDevices, store.bleKind),
    ACCESSORY_NOTICE_DELAY_MS,
  );
  const tallyColor = cameraTallyColor(store.cameraTally);
  const tallyLabel = cameraTallyLabel(store.cameraTally);
  const mainLocked = Boolean(mainKey && store.lockedTargetKeys.includes(mainKey));
  const layerLabel = compact
    ? `${(safeLayerIndex % layers) + 1}/${layers}`
    : `${tr('Layer')} ${(safeLayerIndex % layers) + 1}/${layers}`;

  const layerButton =
    layers > 1 ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={layerLabel}
        onPress={() => setLayerIndex((current) => (current + 1) % layers)}
        style={[styles.layer, compact && styles.layerCompact]}
      >
        {/* Reserve the widest page label, including the jump from 9 to 10. */}
        <Text
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={[styles.layerText, styles.layerSizer]}
        >
          {compact ? `${layers}/${layers}` : `${tr('Layer')} ${layers}/${layers}`}
        </Text>
        <View pointerEvents="none" style={styles.layerLabel}>
          <Text style={styles.layerText}>{layerLabel}</Text>
        </View>
      </Pressable>
    ) : null;

  const replyButton = (
    <HoldToTalk
      accessibilityLabel={mainButton.mode === 'reply' ? tr('Reply') : mainButton.accessibilityLabel}
      disabled={!mainTarget}
      locked={mainLocked}
      leftHanded={store.leftHanded}
      onPress={() => void session.pressMainButton()}
      onLock={() => void session.lockMainButton()}
      onRelease={() => void session.releaseTalk()}
      style={[
        styles.reply,
        replyBeside && styles.replyLandscape,
        compact && !replyBeside && styles.replyCompact,
        store.bigMainButton && styles.replyBig,
        store.bigMainButton && replyBeside && styles.replyBigLandscape,
        mainTalking && styles.replyActive,
        !mainTarget && styles.replyDisabled,
      ]}
    >
      <View
        style={[
          styles.replyContent,
          (store.bigMainButton || replyBeside) && styles.replyContentStacked,
        ]}
      >
        <View
          style={[
            styles.replyTitle,
            store.bigMainButton && styles.replyTitleBig,
            replyBeside && styles.replyTitleLandscape,
          ]}
        >
          {mainLocked ? (
            <LockIcon color={mainTalking ? colors.onAccent : colors.text} size={store.bigMainButton ? 28 : 22} />
          ) : mainButton.mode === 'target' ? (
            <WalkieTalkieIcon
              color={mainTarget ? (mainTalking ? colors.onAccent : colors.accent) : colors.dim}
              size={store.bigMainButton ? 32 : 22}
            />
          ) : (
            <ReplyArrowIcon
              color={mainTarget ? (mainTalking ? colors.onAccent : colors.accent) : colors.dim}
              size={store.bigMainButton ? 28 : 22}
            />
          )}
          <Text
            numberOfLines={2}
            style={[
              styles.replyText,
              replyBeside && styles.replyTextLandscape,
              store.bigMainButton && styles.replyTextBig,
              mainTalking && styles.replyTextActive,
              !mainTarget && styles.replyMuted,
            ]}
          >
            {mainButton.mode === 'reply' ? (reply ? `${tr('Reply')} · ${reply.label}` : tr('Reply')) : mainButton.label}
          </Text>
        </View>
        {mainTarget && !compact ? (
          <Text style={styles.replyHint}>{tr(slideToLockHint(store.leftHanded))}</Text>
        ) : null}
      </View>
    </HoldToTalk>
  );

  return (
    <View
      onLayout={(event) => {
        const next = event.nativeEvent.layout;
        setMeasured((current) =>
          current.width === next.width && current.height === next.height
            ? current
            : { width: next.width, height: next.height },
        );
      }}
      style={[
        styles.screen,
        replyBeside && styles.screenLandscape,
        compact && styles.screenCompact,
        tablet && styles.screenTablet,
        headerCollapsed && styles.screenPeek,
      ]}
    >
      {headerCollapsed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr('Show top bar')}
          accessibilityHint={tr('Reveals name, connection, audio route, and layers')}
          onPress={expandHeader}
          style={styles.headerPeekCard}
        >
          <ChevronIcon color={colors.text} direction="down" size={14} />
        </Pressable>
      ) : (
        <View
          style={[styles.header, compact && styles.headerCompact]}
          onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${tr('Session')}, ${tr(connection.label)}`}
            accessibilityHint={tr('Server, layout, audio, accessories, debug, profiles, and disconnect')}
            onPress={() => openSessionSheet()}
            style={styles.identity}
          >
            <View style={styles.nameRow}>
              <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={1}>
                {store.identity?.name ?? 'LinkTalk'}
              </Text>
              <ConnectionStatusBadge health={connection} compact={compact} />
            </View>
            {productionLabel ? (
              <Text style={styles.production} numberOfLines={1}>
                {productionLabel}
              </Text>
            ) : null}
            {tallyLabel && tallyColor ? (
              <Text
                accessibilityLabel={tallyLabel === 'PGM' ? tr('On program') : tr('On preview')}
                style={[styles.tallyChip, { color: tallyColor }]}
              >
                {tallyLabel}
              </Text>
            ) : null}
          </Pressable>
          <View style={styles.headerActions}>
            {offerCollapse ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tr('Hide top bar')}
                accessibilityHint={tr('Gives the target cards more room on small screens')}
                onPress={collapseHeader}
                style={[styles.collapseButton, compact && styles.collapseButtonCompact]}
              >
                <ChevronIcon color={colors.text} direction="up" />
              </Pressable>
            ) : null}
            <AudioRouteButton />
            {layerButton}
          </View>
        </View>
      )}

      {mediaNotice ? <Text style={styles.warn}>{mediaNotice}</Text> : null}
      {accessoryNotice ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr(accessoryNotice)}
          accessibilityHint={tr('Opens Accessories')}
          onPress={() => openSessionSheet('accessories')}
          style={styles.accessoryNotice}
        >
          <Text style={styles.accessoryNoticeText} numberOfLines={1}>
            {tr(accessoryNotice)}
          </Text>
          <Text style={styles.accessoryNoticeChevron}>›</Text>
        </Pressable>
      ) : null}
      {store.overBudget ? (
        <Text style={styles.warn}>{tr('Too many incoming streams — some feeds paused.')}</Text>
      ) : null}
      {store.error ? <Text style={styles.error}>{tr(store.error)}</Text> : null}

      <View
        style={[
          styles.body,
          replyBeside && styles.bodyLandscape,
          replyBeside && store.leftHanded && styles.bodyLandscapeLeft,
        ]}
      >
        <View
          style={styles.list}
          onLayout={(event) => setListHeight(event.nativeEvent.layout.height)}
        >
          {grid.map((row, rowIndex) => (
            <View key={`row-${rowIndex}`} style={[styles.gridRow, { height: layout.cardHeight, gap: layout.gap }]}>
              {row.map((target) => (
                <View key={`${target.type}-${target.id}`} style={styles.gridCell}>
                  <TargetRow
                    target={target}
                    compact={compact || replyBeside}
                    volumeReadout={compact}
                    height={layout.cardHeight}
                    edgeTalkAffordance={!replyBeside && store.edgeTalkAffordance}
                    onOpenConferenceMembers={setConferenceTarget}
                  />
                </View>
              ))}
              {row.length < layout.columns
                ? Array.from({ length: layout.columns - row.length }, (_, index) => (
                    <View key={`pad-${rowIndex}-${index}`} style={styles.gridCell} />
                  ))
                : null}
            </View>
          ))}
        </View>
        {replyButton}
      </View>

      <ConferenceMembersModal target={conferenceTarget} onClose={() => setConferenceTarget(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 14, backgroundColor: colors.bg },
  screenLandscape: { paddingBottom: 10 },
  screenCompact: { paddingHorizontal: 10, paddingTop: 4, paddingBottom: 8 },
  screenTablet: { paddingHorizontal: 26, paddingTop: 14, paddingBottom: 20 },
  screenPeek: { paddingTop: 0 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerCompact: { marginBottom: 8, gap: 6 },
  headerPeekCard: {
    height: COLLAPSED_HEADER_HEIGHT,
    marginBottom: 8,
    alignSelf: 'center',
    width: 64,
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    backgroundColor: colors.s2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identity: { flexGrow: 1, flexShrink: 1, marginRight: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  name: { color: colors.text, fontFamily: FONT.title, fontWeight: '800', fontSize: 34, letterSpacing: -0.5, flexShrink: 1 },
  nameCompact: { fontSize: 22 },
  production: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    fontFamily: FONT.medium,
    fontSize: 12,
  },
  tallyChip: { marginTop: 4, fontFamily: FONT.black, fontSize: 13, letterSpacing: 1.2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  collapseButton: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.s1, borderWidth: 1, borderColor: colors.hairline },
  collapseButtonCompact: { width: 36, height: 36, borderRadius: 18 },
  layer: { backgroundColor: colors.s1, borderWidth: 1, borderColor: colors.hairline, borderRadius: radius.pill, height: 42, paddingHorizontal: 16, justifyContent: 'center' },
  layerCompact: { height: 36, paddingHorizontal: 12 },
  layerText: { color: colors.text, fontFamily: FONT.medium, fontSize: 13, fontVariant: ['tabular-nums'] },
  layerSizer: { opacity: 0 },
  layerLabel: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  warn: { color: colors.danger, fontFamily: FONT.body, marginBottom: 8 },
  accessoryNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.amberSoft,
  },
  accessoryNoticeText: { flexShrink: 1, color: colors.amber, fontFamily: FONT.medium, fontSize: 13 },
  accessoryNoticeChevron: { color: colors.amber, fontSize: 16 },
  error: { color: colors.danger, fontFamily: FONT.body, marginBottom: 8 },
  body: { flex: 1, minHeight: 0, gap: 12 },
  bodyLandscape: { flexDirection: 'row', gap: 12 },
  bodyLandscapeLeft: { flexDirection: 'row-reverse' },
  list: { flex: 1, minWidth: 0, minHeight: 0, justifyContent: 'flex-end', gap: 10, overflow: 'hidden' },
  gridRow: { flexDirection: 'row', alignItems: 'stretch' },
  gridCell: { flex: 1, minWidth: 0 },
  reply: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: colors.s1,
    borderRadius: radius.pill,
    minHeight: 68,
    paddingHorizontal: 22,
    borderWidth: 2,
    borderColor: colors.accentLine,
  },
  replyLandscape: {
    width: 120,
    minWidth: 100,
    maxWidth: 130,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    paddingHorizontal: 8,
    minHeight: 0,
    borderRadius: radius.xl,
  },
  replyCompact: { minHeight: 54, paddingHorizontal: 14, gap: 8 },
  replyBig: { minHeight: 120, paddingVertical: 16, gap: 14, borderRadius: radius.xl },
  replyBigLandscape: { width: 160, maxWidth: 180 },
  replyActive: { backgroundColor: colors.accent, borderColor: '#FFC08F', shadowColor: colors.accent, shadowOpacity: 0.6, shadowRadius: 22, elevation: 12 },
  replyDisabled: { backgroundColor: colors.bg, borderColor: colors.s3 },
  replyContent: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, minWidth: 0, gap: 12 },
  replyContentStacked: { flexDirection: 'column', width: '100%', gap: 6 },
  replyTitle: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, minWidth: 0, gap: 12 },
  replyTitleBig: { gap: 14 },
  replyTitleLandscape: { flexDirection: 'column' },
  replyText: { color: colors.text, fontFamily: FONT.title, fontWeight: '800', fontSize: 21, letterSpacing: -0.2, flexShrink: 1 },
  replyTextLandscape: { fontSize: 15, textAlign: 'center' },
  replyTextBig: { fontSize: 28, textAlign: 'center' },
  replyTextActive: { color: colors.onAccent },
  replyMuted: { color: colors.dim },
  replyHint: { color: colors.dim, fontFamily: FONT.body, fontSize: 11, textAlign: 'center' },
});

/** Пульт: мультитач-корень, чтобы можно было удерживать нескольких абонентов разными пальцами. */
export function OperatorScreen() {
  return (
    <MultiTouchRoot>
      <OperatorScreenInner />
    </MultiTouchRoot>
  );
}
