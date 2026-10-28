import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  DEFAULT_AUDIO_PREFERENCE,
  formatLinearLevelDb,
  nudgeVolume,
  talkTargetIdentity,
  type TalkTarget,
} from '../protocol';
import { session, useSessionStore } from '../session/store';
import { incomingHighlightsTarget } from '../talk/replyTarget';
import { HoldToTalk } from './HoldToTalk';
import {
  HeadphonesIcon,
  ListenOnlyIcon,
  LockIcon,
  PlayIcon,
  StopIcon,
  WalkieTalkieIcon,
  WEB_AVATAR,
} from './icons';
import { tr } from '../i18n';
import { Monogram, PulseRings } from './kit';
import { colors, FONT, radius } from './theme';
import { conferenceSpeakingLabel, targetActivity } from './targetActivity';
import { VolumeOverlay } from './VolumeOverlay';
import { VolumeRing } from './VolumeRing';

type Props = {
  target: TalkTarget;
  compact?: boolean;
  volumeReadout?: boolean;
  height?: number;
  edgeTalkAffordance?: boolean;
  onOpenConferenceMembers?: (target: TalkTarget) => void;
};

export function TargetRow({
  target,
  compact = false,
  volumeReadout = false,
  height,
  edgeTalkAffordance = false,
  onOpenConferenceMembers,
}: Props) {
  const key = talkTargetIdentity(target);
  const talking = useSessionStore((state) => state.talkingTargetKeys.includes(key));
  const locked = useSessionStore((state) => state.lockedTargetKeys.includes(key));
  const incomingEntries = useSessionStore((state) => state.incoming.addressedNow);
  const incoming = incomingEntries.some((entry) => incomingHighlightsTarget(entry, target));
  const peers = useSessionStore((state) => state.peers);
  const preference = useSessionStore(
    (state) => state.audioPreferences[key] ?? DEFAULT_AUDIO_PREFERENCE,
  );
  const leftHanded = useSessionStore((state) => state.leftHanded);
  const feedStopped = useSessionStore((state) => state.stoppedFeedKeys.includes(key));
  const feedOnline = useSessionStore((state) => state.activeFeedKeys.includes(key));
  const volumeFader = useSessionStore((state) => state.operatorAudio.volumeFader);
  const canTalk = session.canTalkTo(target);
  // Web `#targets-list .talk-btn` always paints the walkie, including offline
  // users. Feeds and listen-only conferences have no talk button.
  const showTalkIcon = target.canTalk && target.type !== 'feed';
  const userOnline =
    target.type !== 'user' || peers.some((peer) => peer.kind === 'user' && peer.userId === target.id);
  const { offline: dimmed, receiving } = targetActivity({
    type: target.type, incoming, feedOnline, feedStopped, userOnline,
  });
  const listenOnly = target.type === 'conference' && !target.canTalk;
  const [volumeOpen, setVolumeOpen] = useState(false);
  const tight = compact || (height != null && height < 64);

  const speaking = receiving;

  const meta =
    target.type === 'feed'
      ? !feedOnline
        ? tr('Offline')
        : feedStopped
          ? tr('Stopped')
          : // LinkTalk 1.5.17: the green border already says it is streaming.
            'Feed'
      : target.type === 'conference'
        ? speaking
          ? conferenceSpeakingLabel(target, incomingEntries, peers)
          : listenOnly
            ? tr('Listen only')
            : tr('Group')
        : userOnline
          ? speaking
            ? tr('Speaking')
            : tr('Online')
          : tr('Offline');

  const avatarSize = tight ? 40 : 48;
  const monogram = (
    <View style={{ width: avatarSize, height: avatarSize, alignItems: 'center', justifyContent: 'center' }}>
      <PulseRings active={talking || speaking} size={avatarSize} color={talking ? colors.accent : colors.amber} />
      {target.type === 'feed' ? (
        <View
          style={{
            width: avatarSize,
            height: avatarSize,
            borderRadius: avatarSize * 0.34,
            backgroundColor: dimmed ? colors.s3 : colors.accentSoft,
            borderWidth: 1,
            borderColor: dimmed ? colors.hairline : colors.accentLine,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <HeadphonesIcon color={dimmed ? colors.dim : colors.accent} />
        </View>
      ) : (
        <Monogram
          label={target.label}
          size={avatarSize}
          online={!dimmed}
          talking={talking}
          group={target.type === 'conference'}
        />
      )}
      {listenOnly ? (
        <View style={styles.listenBadge}>
          <ListenOnlyIcon color={colors.muted} size={10} />
        </View>
      ) : null}
    </View>
  );
  const avatar =
    target.type === 'conference' ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('Choose who you hear in {name}', { name: target.label })}
        onPress={() => onOpenConferenceMembers?.(target)}
      >
        {monogram}
      </Pressable>
    ) : (
      monogram
    );

  const identity = (
    <View style={styles.identity} pointerEvents="none">
      <View style={styles.nameRow}>
        {locked ? <LockIcon color={colors.text} size={14} /> : null}
        <Text style={[styles.label, dimmed && styles.dimText]} numberOfLines={1}>
          {target.label}
        </Text>
      </View>
      <Text style={styles.meta} numberOfLines={1}>
        {meta}
      </Text>
    </View>
  );

  const wrapTalk = (children: ReactNode, style: StyleProp<ViewStyle>, accessibilityLabel: string) => {
    if (canTalk) {
      return (
        <HoldToTalk
          accessibilityLabel={locked ? tr('Unlock {name}', { name: target.label }) : accessibilityLabel}
          disabled={!canTalk}
          locked={locked}
          leftHanded={leftHanded}
          onPress={() => void session.pressTalk(target)}
          onLock={() => void session.lockTalk(target)}
          onRelease={() => void session.releaseTalk(target)}
          style={style}
        >
          {children}
        </HoldToTalk>
      );
    }
    return <View style={style}>{children}</View>;
  };

  const talkZone = wrapTalk(
    identity,
    [styles.talkZone, talking ? styles.talkZoneActive : null],
    tr('Talk to {name}', { name: target.label }),
  );

  const edgeIconColor = talking ? colors.talking : dimmed ? 'rgba(255,255,255,0.28)' : colors.text;
  const talkSlotStyle = [styles.talkControl, edgeTalkAffordance && styles.edgeTalk];

  const talkControl = target.type === 'feed' ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={feedStopped ? tr('Start receiving feed') : tr('Stop receiving feed')}
      accessibilityState={{ disabled: !feedOnline, selected: feedStopped }}
      disabled={!feedOnline}
      onPress={() => session.toggleFeedReception(target)}
      style={[...talkSlotStyle, styles.feedButton, dimmed && styles.controlOffline]}
    >
      {feedStopped ? (
        <PlayIcon color={feedOnline ? '#FFA133' : WEB_AVATAR.offlineGlyph} />
      ) : (
        <StopIcon color={colors.text} />
      )}
    </Pressable>
  ) : showTalkIcon ? (
    wrapTalk(
      <WalkieTalkieIcon color={edgeIconColor} size={tight ? 18 : 22} />,
      [...talkSlotStyle, talking && styles.talkZoneActive],
      edgeTalkAffordance ? tr('Talk to {name} from the phone edge', { name: target.label }) : tr('Talk to {name}', { name: target.label }),
    )
  ) : (
    <View style={talkSlotStyle} />
  );

  const rowStyle = [
    styles.row,
    leftHanded && styles.rowLeft,
    tight && styles.rowCompact,
    talking && styles.rowTalking,
    speaking && !talking && styles.rowSpeaking,
    dimmed && styles.rowOffline,
    height != null ? { height, minHeight: height, flex: 1, paddingVertical: tight ? 4 : 8 } : null,
  ];

  return (
    <View style={rowStyle}>
      {avatar}
      {talkZone}
      <View
        style={[
          styles.meterCluster,
          leftHanded && styles.meterClusterLeft,
          volumeReadout && styles.meterClusterReadout,
        ]}
      >
        <VolumeRing
          level={preference.volume}
          muted={preference.muted}
          dimmed={dimmed}
          compact={tight}
          variant={volumeReadout ? 'readout' : 'ring'}
          accessibilityLabel={
            preference.muted ? tr('Volume muted, {name}', { name: target.label }) : `${tr('Volume')} ${formatLinearLevelDb(preference.volume)}`
          }
          onPress={() => setVolumeOpen(true)}
          onDoublePress={() => session.toggleTargetMuted(target)}
        />
      </View>
      {talkControl}
      <VolumeOverlay
        visible={volumeOpen}
        title={target.label}
        level={preference.volume}
        muted={preference.muted}
        fader={volumeFader}
        onNudge={(direction) => {
          const current = useSessionStore.getState().audioPreferences[key] ?? DEFAULT_AUDIO_PREFERENCE;
          session.setTargetVolume(target, nudgeVolume(current.volume, direction));
        }}
        onChange={(volume) => session.setTargetVolume(target, volume)}
        onToggleMute={() => session.toggleTargetMuted(target)}
        onClose={() => setVolumeOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 12,
    minHeight: 72,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.lg,
    backgroundColor: colors.s1,
    borderWidth: 1,
    borderColor: colors.hairline,
    overflow: 'hidden',
  },
  rowLeft: { flexDirection: 'row-reverse' },
  rowCompact: { minHeight: 62, paddingHorizontal: 10, gap: 10 },
  rowTalking: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.55,
    shadowRadius: 18,
    elevation: 10,
  },
  rowSpeaking: { backgroundColor: colors.amberSoft, borderColor: 'rgba(255,181,71,0.55)' },
  rowOffline: { opacity: 0.5, backgroundColor: colors.bg },
  listenBadge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.s3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  talkZone: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'flex-start',
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 0,
  },
  talkZoneActive: {
    opacity: 1,
  },
  identity: {
    width: '100%',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    color: colors.text,
    fontFamily: FONT.title,
    fontWeight: '800',
    fontSize: 19,
    letterSpacing: -0.2,
    flexShrink: 1,
  },
  dimText: {
    color: colors.dim,
  },
  meta: {
    color: colors.muted,
    fontFamily: FONT.body,
    fontSize: 12,
    marginTop: 1,
  },
  meterCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  meterClusterLeft: {
    flexDirection: 'row-reverse',
  },
  meterClusterReadout: {
    gap: 4,
  },
  feedButton: {
    minWidth: 40,
    minHeight: 40,
  },
  controlOffline: {
    opacity: 0.55,
  },
  talkControl: {
    width: 36,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  edgeTalk: {
    width: 44,
  },
});
