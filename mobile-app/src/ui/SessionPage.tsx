import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { useAppMode } from '../app/appMode';
import { BRAND } from '../app/brand';
import { AboutModal } from './AboutModal';
import { LangSwitch } from './kit';

import { describePttDevicesSummary } from '../ble/bindings';
import { productionChoices, visibleProductionName } from '../protocol';
import { connectionHealthFromSession } from '../session/connectionHealth';
import { session, useSessionStore } from '../session/store';
import { ConnectionStatusBadge } from './ConnectionStatusBadge';
import { TrashIcon } from './icons';
import {
  SettingsActionRow,
  SettingsHint,
  SettingsNavRow,
  SettingsRow,
  SettingsSection,
  useSettingsStyles,
  useSettingsTheme,
} from './settingsChrome';
import { tr } from '../i18n';

/** Root menu of the session sheet; each settings category opens directly. */
export function SessionPage({
  onClose,
  onOpenLayout,
  onOpenAudio,
  onOpenAccessories,
  onOpenDebug,
  onOpenProfiles,
}: {
  onClose: () => void;
  onOpenLayout: () => void;
  onOpenAudio: () => void;
  onOpenAccessories: () => void;
  onOpenDebug: () => void;
  onOpenProfiles: () => void;
}) {
  const store = useSessionStore();
  const styles = useSettingsStyles();
  const { scheme } = useSettingsTheme();
  const production = visibleProductionName(store.productionName);
  const choices = store.productions.length > 0 ? productionChoices(store.productions) : [];
  const connection = connectionHealthFromSession(store);
  const appMode = useAppMode((state) => state.mode);
  const [aboutOpen, setAboutOpen] = useState(false);

  useEffect(() => {
    void session.refreshMonitors();
  }, []);

  const disconnect = () => {
    Alert.alert(
      tr('Disconnect?'),
      tr('You will appear offline. Opening the app again reconnects you to this production.'),
      [
        { text: tr('Cancel'), style: 'cancel' },
        {
          text: tr('Disconnect'),
          style: 'destructive',
          onPress: () => {
            onClose();
            void session.disconnect();
          },
        },
      ],
    );
  };

  return (
    <>
      <SettingsSection title={tr('Signed in as')}>
        <SettingsRow label={store.identity?.name ?? store.username} />
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{tr('Connection')}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
            <ConnectionStatusBadge health={connection} light={scheme === 'light'} />
          </View>
        </View>
        <SettingsRow label={tr('Server')} value={store.serverAddress} />
        {production && choices.length === 0 ? <SettingsRow label={tr('Production')} value={production} /> : null}
      </SettingsSection>

      {choices.length > 0 ? (
        <SettingsSection title={tr('Production')}>
          {choices.map((choice) => {
            const selected = choice.id === store.productionId;
            return (
              <SettingsRow
                key={choice.id ?? 'default'}
                label={choice.name}
                value={selected ? tr('Selected') : ''}
                selected={selected}
                onPress={() => {
                  void session.selectProduction(
                    choice.id === null ? null : { id: choice.id, name: choice.name },
                  );
                }}
              />
            );
          })}
        </SettingsSection>
      ) : null}

      <SettingsSection title={tr('Language')}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, alignItems: 'flex-start' }}>
          <LangSwitch />
        </View>
      </SettingsSection>

      {store.monitors.length > 0 ? (
        <SettingsSection title={tr('Monitoring')}>
          {store.monitors.map((monitor) => (
            <SettingsRow
              key={monitor.targetUserId}
              label={monitor.name}
              value={monitor.forced ? tr('Forced') : monitor.enabled ? tr('On') : tr('Off')}
              selected={monitor.enabled}
              onPress={monitor.forced ? undefined : () => void session.setMonitor(monitor.targetUserId, !monitor.enabled)}
            />
          ))}
          <SettingsHint
            full={tr('You hear this person at all times, whoever they talk to. The administrator grants this in the Matrix.')}
            compact={tr('Hear this person at all times.')}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title={tr('Work mode')}>
        <SettingsRow
          label={tr('Walkie-talkie')}
          value={appMode === 'walkie' ? tr('Selected') : ''}
          selected={appMode === 'walkie'}
          onPress={() => {
            useAppMode.getState().switchMode('walkie');
            onClose();
          }}
        />
        <SettingsRow
          label={tr('Intercom panel')}
          value={appMode === 'panel' ? tr('Selected') : ''}
          selected={appMode === 'panel'}
          onPress={() => {
            useAppMode.getState().switchMode('panel');
            onClose();
          }}
        />
        <SettingsActionRow
          label={tr('Ask for the mode on launch')}
          onPress={() => {
            useAppMode.getState().choose(appMode ?? 'walkie', false);
            onClose();
          }}
        />
      </SettingsSection>

      <SettingsSection>
        <SettingsNavRow label={tr('Layout')} onPress={onOpenLayout} />
        <SettingsNavRow label={tr('Audio')} onPress={onOpenAudio} />
        <SettingsNavRow
          label={tr('Accessories')}
          value={describePttDevicesSummary(store.bleBindings, store.bleDevices)}
          onPress={onOpenAccessories}
        />
        <SettingsNavRow label={tr('Debug')} onPress={onOpenDebug} />
        <SettingsNavRow label={tr('About')} value={`${BRAND.name} ${BRAND.version}`} onPress={() => setAboutOpen(true)} />
      </SettingsSection>
      <AboutModal visible={aboutOpen} onClose={() => setAboutOpen(false)} />

      <SettingsSection>
        <SettingsNavRow label={tr('Profiles')} onPress={onOpenProfiles} />
        <Pressable accessibilityRole="button" onPress={disconnect} style={[styles.row, styles.actionTop]}>
          <Text style={[styles.navLabel, styles.destructiveLabel]}>{tr('Disconnect')}</Text>
        </Pressable>
      </SettingsSection>
    </>
  );
}

/**
 * Session › Profiles. Opening it changes nothing; picking another profile, adding one, or scanning
 * a QR code leaves this session first, then continues on the profile screens.
 */
export function ProfilesPage({ onClose }: { onClose: () => void }) {
  const profiles = useSessionStore((state) => state.profiles);
  const activeProfileId = useSessionStore((state) => state.activeProfileId);
  const styles = useSettingsStyles();
  const { palette } = useSettingsTheme();

  const leaveThen = (next: () => void | Promise<void>) => {
    onClose();
    void session.leaveToProfiles().then(next);
  };

  return (
    <>
      <SettingsSection>
        {profiles.map((profile, index) => {
          const current = profile.id === activeProfileId;
          const production = visibleProductionName(profile.productionName);
          return (
            <View key={profile.id} style={[styles.orderRow, index > 0 && styles.orderRowDivider]}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: current }}
                disabled={current}
                onPress={() => leaveThen(() => session.connectProfile(profile.id))}
                style={styles.orderText}
              >
                <Text style={styles.orderName} numberOfLines={1}>
                  {profile.username}
                </Text>
                <Text style={styles.orderKind} numberOfLines={1}>
                  {production ? `${profile.serverAddress} · ${production}` : profile.serverAddress}
                </Text>
              </Pressable>
              {current ? (
                <Text style={[styles.rowValue, styles.profileCurrent]}>{tr('Connected')}</Text>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={tr('Remove {name}', { name: profile.username })}
                  hitSlop={8}
                  style={styles.orderButton}
                  onPress={() =>
                    Alert.alert(tr('Remove profile?'), `${profile.username}\n${profile.serverAddress}`, [
                      { text: tr('Cancel'), style: 'cancel' },
                      {
                        text: tr('Remove'),
                        style: 'destructive',
                        onPress: () => void session.removeSavedProfile(profile.id),
                      },
                    ])
                  }
                >
                  <TrashIcon color={palette.danger} />
                </Pressable>
              )}
            </View>
          );
        })}
        <SettingsHint
          full={tr('You stay connected until you pick another profile. Picking, adding, or scanning disconnects this session first.')}
          compact={tr('You stay connected until you pick another profile.')}
        />
      </SettingsSection>

      <SettingsSection>
        <SettingsActionRow label={tr('Add profile')} onPress={() => leaveThen(() => session.startAddProfile())} />
        <SettingsActionRow
          label={tr('Scan QR code')}
          onPress={() => leaveThen(() => session.startAddProfile({ openScanner: true }))}
        />
      </SettingsSection>
    </>
  );
}
