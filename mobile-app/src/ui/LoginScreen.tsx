import { useEffect, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { SessionConflictError, TlsUntrustedError } from '../auth/errors';
import { parseConnectPayload } from '../servers/parseConnectPayload';
import { formatFingerprint } from '../servers/fingerprint';
import { session, useSessionStore } from '../session/store';
import { QrIcon } from './icons';
import { QrScannerModal } from './QrScannerModal';
import { isCompactOperatorScreen } from './layers';
import { LangSwitch } from './kit';
import { colors, FONT, radius } from './theme';
import { tr } from '../i18n';

type LoginMethod = 'account' | 'link';

export function LoginScreen() {
  const store = useSessionStore();
  const { width, height } = useWindowDimensions();
  const compact = isCompactOperatorScreen(width, height);
  const [method, setMethod] = useState<LoginMethod>('account');
  const [password, setPassword] = useState('');
  const [loginLink, setLoginLink] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const guest = store.loginOptions?.guestLogin;
  const canGoBack = store.profiles.length > 0;

  const openLoginScanner = useSessionStore((state) => state.openLoginScanner);
  const setField = useSessionStore((state) => state.setField);

  useEffect(() => {
    if (store.hydrated) {
      setPassword((current) => current || session.rememberedPassword());
    }
  }, [store.hydrated]);

  useEffect(() => {
    if (openLoginScanner) {
      setScanning(true);
      setField('openLoginScanner', false);
    }
  }, [openLoginScanner, setField]);

  useEffect(() => {
    if (store.serverAddress.trim()) {
      const handle = setTimeout(() => {
        void session.refreshLoginOptions(store.serverAddress);
      }, 400);
      return () => clearTimeout(handle);
    }
    return undefined;
  }, [store.serverAddress]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      if (error instanceof SessionConflictError) {
        useSessionStore.setState({
          status: 'idle',
          conflictName: error.existing?.name ?? store.username,
          error: null,
        });
      } else if (error instanceof TlsUntrustedError) {
        const pending = useSessionStore.getState().pendingCertificate;
        useSessionStore.setState({
          status: 'idle',
          statusMessage: pending ? tr('This certificate is not in the system trust store.') : '',
          error: pending ? null : error.message,
        });
      } else {
        useSessionStore.setState({
          status: 'idle',
          statusMessage: '',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const signInWithLink = (raw: string, force = false) => {
    if (/^http:\/\//i.test(raw.trim())) {
      useSessionStore.setState({
        error: tr('The server address must use HTTPS.'),
        statusMessage: '',
      });
      return Promise.resolve();
    }
    const parsed = parseConnectPayload(raw);
    const serverAddress = parsed.serverAddress || store.serverAddress;
    if (!parsed.token) {
      useSessionStore.setState({
        error: tr('Paste a LinkTalk login link that includes #login=.'),
        statusMessage: '',
      });
      return Promise.resolve();
    }
    if (!serverAddress.trim()) {
      useSessionStore.setState({
        error: tr('This login link is missing a server address.'),
        statusMessage: '',
      });
      return Promise.resolve();
    }
    setMethod('link');
    setLoginLink(raw.trim());
    if (parsed.serverAddress) {
      store.setField('serverAddress', parsed.serverAddress);
    }
    return session.loginWithToken({
      serverAddress,
      token: parsed.token,
      rememberPassword: true,
      force,
    });
  };

  const submit = (force = false) =>
    run(() => {
      if (method === 'link') {
        return signInWithLink(loginLink, force);
      }
      return session.login({
        serverAddress: store.serverAddress,
        username: store.username,
        password,
        rememberPassword: store.rememberPassword,
        force,
      });
    });

  const applyLoginLink = (value: string) => {
    setLoginLink(value);
    const parsed = parseConnectPayload(value);
    if (parsed.token) {
      if (parsed.serverAddress) {
        store.setField('serverAddress', parsed.serverAddress);
      }
      return;
    }
    if (parsed.serverAddress && !parsed.token) {
      store.setField('serverAddress', parsed.serverAddress);
      setMethod('account');
      setLoginLink('');
    }
  };

  const applyServerInput = (value: string) => {
    const parsed = parseConnectPayload(value);
    if (parsed.token) {
      setMethod('link');
      setLoginLink(value.trim());
      if (parsed.serverAddress) {
        store.setField('serverAddress', parsed.serverAddress);
      }
      return;
    }
    store.setField('serverAddress', value);
  };

  const applyScanned = (raw: string) => {
    setScanning(false);
    if (/^http:\/\//i.test(raw.trim())) {
      useSessionStore.setState({ error: tr('The server address must use HTTPS.'), statusMessage: '' });
      return;
    }
    const parsed = parseConnectPayload(raw);
    if (!parsed.serverAddress && !parsed.token) {
      useSessionStore.setState({ error: tr('This QR code is not a LinkTalk server or login link.') });
      return;
    }
    if (parsed.token) {
      void run(() => signInWithLink(raw));
      return;
    }
    setMethod('account');
    store.setField('serverAddress', parsed.serverAddress ?? '');
    useSessionStore.setState({ error: null, statusMessage: tr('Server filled from QR code. Enter your account.') });
  };

  const openScanner = () => {
    useSessionStore.setState({ error: null, statusMessage: '' });
    setScanning(true);
  };

  return (
    <KeyboardAvoidingView
      style={[styles.screen, compact && styles.screenCompact]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.scrollFill}
        contentContainerStyle={[styles.scroll, compact && styles.scrollCompact]}
        keyboardShouldPersistTaps="handled"
      >
        {canGoBack ? (
          <Pressable accessibilityRole="button" onPress={() => session.cancelAddProfile()} style={styles.back}>
            <Text style={styles.backText}>{tr('Profiles')}</Text>
          </Pressable>
        ) : null}
        <View style={[styles.intro, compact && styles.introCompact]}>
          <View style={styles.langRow}>
            <LangSwitch />
          </View>
          <View style={styles.brandRow}>
            <Image
              source={require('../../assets/linktalk-mark.png')}
              style={[styles.brandIcon, compact && styles.brandIconCompact]}
            />
            <Text style={[styles.brand, compact && styles.brandCompact]}>{tr('LinkTalk')}</Text>
          </View>
          <Text style={[styles.subtitle, compact && styles.subtitleCompact]}>
            {tr('Connect with an operator account or a login link.')}
          </Text>
        </View>

        <View style={[styles.card, compact && styles.cardCompact]}>
          <View style={styles.segment} accessibilityRole="tablist">
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: method === 'account' }}
              style={[styles.segmentItem, method === 'account' && styles.segmentItemOn]}
              onPress={() => setMethod('account')}
            >
              <Text style={[styles.segmentText, method === 'account' && styles.segmentTextOn]}>{tr('Account')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: method === 'link' }}
              style={[styles.segmentItem, method === 'link' && styles.segmentItemOn]}
              onPress={() => setMethod('link')}
            >
              <Text style={[styles.segmentText, method === 'link' && styles.segmentTextOn]}>{tr('Login link')}</Text>
            </Pressable>
          </View>

          {method === 'account' ? (
            <>
              <Text style={styles.label}>{tr('Server')}</Text>
              <ScanField
                accessibilityLabel={tr('Server')}
                keyboardType="url"
                placeholder="https://intercom.local"
                value={store.serverAddress}
                onChangeText={applyServerInput}
                onScan={openScanner}
                scanLabel={tr('Scan server QR')}
              />

              <Text style={styles.label}>{tr('Username')}</Text>
              <TextInput
                accessibilityLabel={tr('Username')}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={tr('Username')}
                placeholderTextColor={colors.dim}
                style={styles.input}
                value={store.username}
                onChangeText={(value) => store.setField('username', value)}
              />

              <Text style={styles.label}>{tr('Password')}</Text>
              <TextInput
                accessibilityLabel={tr('Password')}
                secureTextEntry
                placeholder={tr('Password')}
                placeholderTextColor={colors.dim}
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                onSubmitEditing={() => void submit()}
              />

              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>{tr('Remember password')}</Text>
                <Switch
                  value={store.rememberPassword}
                  onValueChange={(value) => store.setField('rememberPassword', value)}
                  trackColor={{ true: colors.accent }}
                />
              </View>
            </>
          ) : (
            <>
              <Text style={styles.label}>{tr('Login link')}</Text>
              <ScanField
                accessibilityLabel={tr('Login link')}
                keyboardType="url"
                placeholder="https://host/#login=…"
                value={loginLink}
                onChangeText={applyLoginLink}
                onScan={openScanner}
                scanLabel={tr('Scan login QR')}
                onSubmitEditing={() => void submit()}
              />
              <Text style={styles.hint}>
                {tr('Use a personal login link from LinkTalk. It already includes the server.')}
              </Text>
            </>
          )}

          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>{tr('Allow self-signed local TLS')}</Text>
            <Switch
              value={store.allowInsecureLocalTLS}
              onValueChange={(value) => store.setField('allowInsecureLocalTLS', value)}
              trackColor={{ true: colors.accent }}
            />
          </View>
          <Text style={styles.hint}>
            {compact
              ? tr('Pin a local certificate fingerprint. TLS stays on.')
              : tr('When a local certificate is not in the system store, LinkTalk can pin its SHA-256 fingerprint. This never disables TLS checks for every host.')}
          </Text>

          {store.pendingCertificate ? (
            <View style={styles.trust}>
              <Text style={styles.trustTitle}>{tr('Trust this certificate?')}</Text>
              <Text style={styles.trustBody}>{store.pendingCertificate.hostname}</Text>
              <Text style={styles.fingerprint}>
                SHA-256 {formatFingerprint(store.pendingCertificate.sha256)}
              </Text>
              {store.pendingCertificate.issuer ? (
                <Text style={styles.trustBody}>{store.pendingCertificate.issuer}</Text>
              ) : null}
              <Pressable
                style={styles.takeOver}
                onPress={() => void run(() => session.acceptCertificateAndRetry('user'))}
                disabled={busy}
                accessibilityRole="button"
              >
                <Text style={styles.takeOverText}>{busy ? tr('Trusting…') : tr('Trust and continue')}</Text>
              </Pressable>
            </View>
          ) : null}

          {store.conflictName ? (
            <View style={styles.conflict}>
              <Text style={styles.conflictTitle}>{tr('User already signed in')}</Text>
              <Text style={styles.conflictBody}>
                This user is already signed in on another session ({store.conflictName}). You can
                disconnect that session and take it over.
              </Text>
              <Pressable
                style={styles.takeOver}
                onPress={() => void submit(true)}
                disabled={busy}
                accessibilityRole="button"
              >
                <Text style={styles.takeOverText}>
                  {busy ? tr('Taking over...') : tr('Take over other session')}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {store.error ? <Text style={styles.error}>{tr(store.error)}</Text> : null}
          {store.statusMessage ? <Text style={styles.status}>{tr(store.statusMessage)}</Text> : null}
        </View>
      </ScrollView>

      <View style={styles.actions}>
        {method === 'account' && guest?.enabled ? (
          <Pressable
            accessibilityRole="button"
            style={[styles.guest, busy && styles.buttonDisabled]}
            onPress={() =>
              void run(() =>
                session.loginGuest({
                  serverAddress: store.serverAddress,
                  displayName: store.username,
                }),
              )
            }
            disabled={busy}
          >
            <Text style={styles.guestText}>
              {busy ? tr('Signing in…') : tr('Continue as {name}', { name: guest.label || tr('Guest') })}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          style={[styles.signIn, busy && styles.buttonDisabled]}
          onPress={() => void submit()}
          disabled={busy}
        >
          <Text style={styles.signInText}>{busy ? tr('Signing in…') : tr('Sign In')}</Text>
        </Pressable>
      </View>
      <QrScannerModal visible={scanning} onClose={() => setScanning(false)} onScanned={applyScanned} />
    </KeyboardAvoidingView>
  );
}

function ScanField({
  accessibilityLabel,
  keyboardType,
  placeholder,
  value,
  onChangeText,
  onScan,
  scanLabel,
  onSubmitEditing,
}: {
  accessibilityLabel: string;
  keyboardType: 'url';
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  onScan: () => void;
  scanLabel: string;
  onSubmitEditing?: () => void;
}) {
  return (
    <View style={styles.inputWrap}>
      <TextInput
        accessibilityLabel={accessibilityLabel}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor={colors.dim}
        style={styles.inputInWrap}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmitEditing}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={scanLabel}
        hitSlop={8}
        onPress={onScan}
        style={styles.inputScan}
      >
        <QrIcon color={colors.onAccent} size={18} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 16, backgroundColor: colors.bg },
  screenCompact: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  scrollFill: { flex: 1, minHeight: 0 },
  scroll: { paddingBottom: 16 },
  scrollCompact: { paddingBottom: 8 },
  back: { alignSelf: 'flex-start', marginBottom: 12, paddingVertical: 6 },
  backText: { color: colors.accent, fontFamily: FONT.medium, fontSize: 16 },
  intro: { marginTop: 4, marginBottom: 18 },
  introCompact: { marginTop: 0, marginBottom: 10 },
  langRow: { alignItems: 'flex-end', marginBottom: 14 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  brandIcon: { width: 46, height: 46, borderRadius: 14 },
  brandIconCompact: { width: 32, height: 32, borderRadius: 10 },
  brand: { color: colors.text, fontFamily: FONT.black, fontSize: 38, letterSpacing: 0.5 },
  brandCompact: { fontSize: 28 },
  subtitle: { color: colors.muted, marginTop: 8, fontSize: 16, lineHeight: 22 },
  subtitleCompact: { fontSize: 13, marginTop: 4 },
  card: {
    backgroundColor: colors.s1,
    borderColor: colors.hairline,
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: 20,
  },
  cardCompact: { padding: 14, borderRadius: radius.lg },
  segment: { flexDirection: 'row', backgroundColor: colors.bg, borderRadius: radius.pill, padding: 4, marginBottom: 6 },
  segmentItem: { flex: 1, borderRadius: radius.pill, paddingVertical: 11, alignItems: 'center' },
  segmentItemOn: { backgroundColor: colors.accent },
  segmentText: { color: colors.muted, fontFamily: FONT.medium, fontSize: 15 },
  segmentTextOn: { color: colors.onAccent },
  label: { color: colors.muted, marginBottom: 6, marginTop: 16, fontFamily: FONT.medium, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase' },
  input: {
    backgroundColor: colors.s2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.s2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  inputInWrap: { flex: 1, color: colors.text, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16 },
  inputScan: { margin: 6, paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.sm, backgroundColor: colors.accent },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 },
  toggleLabel: { color: colors.text, flex: 1, paddingRight: 12, fontFamily: FONT.medium },
  hint: { color: colors.dim, fontSize: 12, marginTop: 10, lineHeight: 17 },
  trust: { marginTop: 16, padding: 14, borderRadius: radius.lg, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentLine },
  trustTitle: { color: colors.text, fontFamily: FONT.medium, fontSize: 15 },
  trustBody: { color: colors.muted, marginTop: 8, fontSize: 13 },
  fingerprint: { color: colors.text, marginTop: 8, fontSize: 12, fontFamily: FONT.mono },
  conflict: { marginTop: 16, padding: 14, borderRadius: radius.lg, backgroundColor: colors.amberSoft, borderWidth: 1, borderColor: 'rgba(255,181,71,0.4)' },
  conflictTitle: { color: colors.text, fontFamily: FONT.medium, fontSize: 15 },
  conflictBody: { color: colors.muted, marginTop: 8, fontSize: 13 },
  takeOver: { marginTop: 12, backgroundColor: colors.amber, borderRadius: radius.pill, paddingVertical: 12, alignItems: 'center' },
  takeOverText: { color: colors.onAccent, fontFamily: FONT.medium },
  error: { color: colors.danger, marginTop: 12 },
  status: { color: colors.muted, marginTop: 8 },
  actions: { gap: 10 },
  guest: { borderRadius: radius.pill, paddingVertical: 15, alignItems: 'center', borderWidth: 1, borderColor: colors.hairlineStrong, backgroundColor: colors.s2 },
  guestText: { color: colors.text, fontFamily: FONT.medium, fontSize: 16 },
  signIn: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingVertical: 17, alignItems: 'center' },
  signInText: { color: colors.onAccent, fontFamily: FONT.black, fontSize: 18, letterSpacing: 0.5 },
  buttonDisabled: { opacity: 0.6 },
});
