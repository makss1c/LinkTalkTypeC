import { useEffect, useState } from 'react';
import { Platform, Switch, Text, View } from 'react-native';

import {
  BLE_MAX_ACCESSORIES,
  describeBindingTargets,
  describeBleDeviceStatus,
  describeBleReleaseTimeout,
  liveDeviceById,
  visibleButtons,
  visibleTalkButtons,
} from '../ble/bindings';
import { BLE_BUTTON_PAIRING_MS } from '../ble/catalog';
import { describeBleTarget, type BleTargetSelection } from '../ble/target';
import { describePttButton, describePttDeviceKind, isChannelButton, ONBOARD_DEVICE_ID } from '../hardware/events';
import type { PttButton } from '../hardware/events';
import { session, useSessionStore } from '../session/store';
import {
  SettingsActionRow,
  SettingsFootnote,
  SettingsHint,
  SettingsNavRow,
  SettingsRow,
  SettingsSection,
  useSettingsStyles,
} from './settingsChrome';
import { tr } from '../i18n';

export function PttDevicesPage({
  onAddDevice,
  onOpenDevice,
}: {
  onAddDevice: () => void;
  onOpenDevice: (id: string) => void;
}) {
  const store = useSessionStore();
  const styles = useSettingsStyles();
  const atLimit = store.bleBindings.length >= BLE_MAX_ACCESSORIES;

  return (
    <>
      <SettingsSection title={tr('Devices')}>
        {store.bleBindings.length === 0 ? (
          <SettingsFootnote>{tr('No PTT accessories yet. Add one below.')}</SettingsFootnote>
        ) : (
          store.bleBindings.map((binding) => {
            const live = liveDeviceById(store.bleDevices, binding.id, binding);
            return (
              <SettingsNavRow
                key={binding.id}
                label={binding.name}
                subtitle={describeBindingTargets(binding)}
                value={describeBleDeviceStatus(live, binding)}
                onPress={() => onOpenDevice(binding.id)}
              />
            );
          })
        )}
        <SettingsActionRow
          label={atLimit ? tr('Limit of {count} accessories', { count: BLE_MAX_ACCESSORIES }) : tr('Add a device')}
          disabled={atLimit}
          onPress={onAddDevice}
        />
        <SettingsHint
          full={tr('Pair speaker-mic audio (HFP/HSP) in system Bluetooth first. Add a device here to bind the PTT button: hold it until LinkTalk hears a known command. Catalog names are only a hint — unknown Zello BLE, Classic serial, USB-C, and rugged-phone keys still bind.')}
          compact={tr('Pair speaker-mic audio in system Bluetooth first. Hold PTT here to bind the button.')}
        />
      </SettingsSection>

      <SettingsSection title={tr('Button behavior')}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{tr('Short press locks')}</Text>
          <Switch
            value={store.bleShortPressLocks}
            onValueChange={(value) => session.setBluetoothButtonShortPressLocks(value)}
            trackColor={{ true: '#3DD6F5' }}
          />
        </View>
        <SettingsRow
          label={tr('Release timeout')}
          value={describeBleReleaseTimeout(store.bleReleaseTimeoutMs)}
          onPress={() => session.cycleBluetoothReleaseTimeout()}
        />
        <SettingsHint
          full={tr('If a PTT release is lost, LinkTalk closes the mic after this delay. Off never forces a release (disconnect still does). Tap to cycle 10s / 15s / 30s / 1 min / 2 min / Off.')}
          compact={tr('Closes the mic if a PTT release is lost. Tap to cycle timeout / Off.')}
        />
      </SettingsSection>
    </>
  );
}

export function PttAddDevicePage({ onBound }: { onBound: () => void }) {
  const store = useSessionStore();
  const styles = useSettingsStyles();
  const [remaining, setRemaining] = useState(Math.round(BLE_BUTTON_PAIRING_MS / 1000));
  const [armed, setArmed] = useState(false);
  const serial = store.bondedSerialDevices.filter(
    (item) => !store.bleBindings.some((binding) => binding.id === item.id),
  );

  useEffect(() => {
    void session.beginButtonPairing();
    return () => {
      void session.cancelButtonPairing();
    };
  }, []);

  useEffect(() => {
    if (store.blePairingActive) {
      setArmed(true);
    }
  }, [store.blePairingActive]);

  useEffect(() => {
    if (armed && store.blePairingFoundId) {
      onBound();
    }
  }, [armed, onBound, store.blePairingFoundId]);

  useEffect(() => {
    if (!store.blePairingActive) {
      return;
    }
    const started = Date.now();
    setRemaining(Math.round(BLE_BUTTON_PAIRING_MS / 1000));
    const timer = setInterval(() => {
      setRemaining(Math.max(0, Math.round((BLE_BUTTON_PAIRING_MS - (Date.now() - started)) / 1000)));
    }, 250);
    return () => clearInterval(timer);
  }, [store.blePairingActive]);

  const listening = store.blePairingActive;
  const message =
    store.blePairingMessage || (listening ? tr('Hold a PTT button, SOS, or turn the channel knob.') : '');

  return (
    <>
      <SettingsSection>
        <View style={styles.pairingHero}>
          <Text style={styles.pairingTitle}>
            {listening ? tr('Hold the PTT button') : store.blePairingFoundId ? tr('Device added') : tr('No button heard')}
          </Text>
          <Text style={styles.pairingBody}>{message}</Text>
          {listening ? <Text style={styles.pairingTimer}>{remaining}s</Text> : null}
        </View>
        {listening ? (
          <SettingsHint
            full={tr('LinkTalk listens for Zello BLE notifies, Classic serial tokens, USB-C keycodes, and onboard rugged-phone keys (RG440, Sonim, Inrico, and anything that broadcasts Zello intents). Keep holding until the timer ends or the device appears.')}
            compact={tr('Hold PTT until the timer ends or the device appears.')}
          />
        ) : (
          <SettingsActionRow label={tr('Try again')} onPress={() => void session.beginButtonPairing()} />
        )}
      </SettingsSection>
      {Platform.OS === 'android' && serial.length > 0 ? (
        <SettingsSection title={tr('Bonded serial devices')}>
          {serial.map((item) => (
            <SettingsActionRow
              key={item.id}
              label={item.pttHint ? `${item.name} (PTT)` : item.name}
              onPress={() => void session.probeSerialAccessory(item.id)}
            />
          ))}
          <SettingsHint
            full={tr('Zello speaker-mics that advertise PTT in the Bluetooth name are probed automatically. Pick any other bonded Classic device if its name does not contain PTT.')}
            compact={tr('Names with PTT are probed automatically. Pick another bonded device if needed.')}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}

export function PttDeviceDetailPage({
  deviceId,
  onDeleted,
}: {
  deviceId: string;
  onDeleted: () => void;
}) {
  const store = useSessionStore();
  const styles = useSettingsStyles();
  const binding = store.bleBindings.find((item) => item.id === deviceId);
  const live = liveDeviceById(store.bleDevices, deviceId, binding);
  const connected = live?.kind === 'connected' || live?.kind === 'connecting' || binding?.kind === 'onboard';
  const candidates = session.bluetoothButtonCandidates();
  const talkButtons = binding ? visibleTalkButtons(binding) : [];
  const hasChannel = binding ? visibleButtons(binding).some((button) => isChannelButton(button)) : false;

  useEffect(() => {
    if (!binding) {
      onDeleted();
    }
  }, [binding, onDeleted]);

  if (!binding) {
    return null;
  }

  return (
    <>
      <SettingsSection title={tr('Accessory')}>
        <SettingsRow label={tr('Transport')} value={describePttDeviceKind(binding.kind)} />
        <SettingsRow label={tr('Status')} value={describeBleDeviceStatus(live, binding)} />
        {binding.kind === 'onboard' ? (
          <SettingsHint
            full={tr('Phone keys stay available while LinkTalk is running, including with the screen off. On a RugGear RG440, set CustomKey to PTT so the side key broadcasts Zello intents.')}
            compact={tr('Phone keys work with the screen off. On RG440 set CustomKey to PTT.')}
          />
        ) : connected ? (
          <SettingsActionRow
            label={tr('Disconnect')}
            onPress={() => void session.disconnectBluetoothButton(deviceId)}
          />
        ) : (
          <SettingsActionRow
            label={tr('Connect')}
            onPress={() => void session.connectKnownBluetoothAccessory(deviceId)}
          />
        )}
      </SettingsSection>

      {talkButtons.map((button) => (
        <TalkTargetSection
          key={`${deviceId}-${button}`}
          deviceId={deviceId}
          button={button}
          candidates={candidates}
        />
      ))}

      {hasChannel ? (
        <SettingsSection title={tr('Channel knob / up-down')}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>{tr('Change PTT 1 target')}</Text>
            <Switch
              value={binding.rotaryRetargetsPtt1}
              onValueChange={(value) => session.setRotaryRetargetsPtt1(deviceId, value)}
              trackColor={{ true: '#3DD6F5' }}
            />
          </View>
          <SettingsHint
            full={tr('When this is on, the channel knob and up/down retarget PTT 1. Otherwise they do nothing. SOS always replies.')}
            compact={tr('Knob and up/down retarget PTT 1 when this is on. SOS always replies.')}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection>
        <SettingsActionRow
          label={deviceId === ONBOARD_DEVICE_ID ? tr('Remove this phone') : tr('Delete device')}
          destructive
          onPress={() => {
            session.removeBluetoothAccessory(deviceId);
            onDeleted();
          }}
        />
      </SettingsSection>
    </>
  );
}

function TalkTargetSection({
  deviceId,
  button,
  candidates,
}: {
  deviceId: string;
  button: PttButton;
  candidates: ReturnType<typeof session.bluetoothButtonCandidates>;
}) {
  const selection = session.bluetoothButtonSelection(deviceId, button);
  const lockedSos = button === 'sos';
  return (
    <SettingsSection title={tr('{button} target', { button: tr(describePttButton(button)) })}>
      {lockedSos ? (
        <>
          <SettingsRow label={tr('Reply')} value={tr('Always')} selected />
          <SettingsFootnote>{tr('SOS always talks to Reply in this production.')}</SettingsFootnote>
        </>
      ) : (
        <>
          <TargetChoice
            selection={{ kind: 'reply' }}
            current={selection}
            onPress={() => session.setBluetoothButtonTarget({ kind: 'reply' }, deviceId, button)}
          />
          {candidates.map((target) => (
            <TargetChoice
              key={`${deviceId}-${button}-${target.type}-${target.id}`}
              selection={{
                kind: 'target',
                type: target.type,
                id: target.id,
                label: target.label,
              }}
              current={selection}
              onPress={() =>
                session.setBluetoothButtonTarget(
                  {
                    kind: 'target',
                    type: target.type,
                    id: target.id,
                    label: target.label,
                  },
                  deviceId,
                  button,
                )
              }
            />
          ))}
          <SettingsHint
            full={tr('Reply follows this production (last incoming, else first talkable card). A fixed target is used only while that card exists here.')}
            compact={tr('Reply follows last incoming, else the first talkable card.')}
          />
        </>
      )}
    </SettingsSection>
  );
}

function TargetChoice({
  selection,
  current,
  onPress,
}: {
  selection: BleTargetSelection;
  current: BleTargetSelection;
  onPress: () => void;
}) {
  const selected =
    selection.kind === 'reply'
      ? current.kind === 'reply'
      : current.kind === 'target' &&
        current.type === selection.type &&
        String(current.id) === String(selection.id);
  return (
    <SettingsRow label={tr(describeBleTarget(selection))} value={selected ? tr('Selected') : ''} selected={selected} onPress={onPress} />
  );
}
