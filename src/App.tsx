import { MaterialIcons } from '@expo/vector-icons';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  createNavigationContainerRef,
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type Theme,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { requestSmsPermission } from '../modules/sms-reader';
import { Button, Icon } from './components/ui';
import { getDb } from './db/database';
import { makeTransaction } from './models/transaction';
import type { RootStackParamList, TabParamList } from './navigation/types';
import { profileRepository } from './repositories/profileRepository';
import { transactionRepository } from './repositories/transactionRepository';
import { AccountDetailScreen, AccountsScreen, AddAccountScreen, ScanAccountScreen } from './screens/AccountsScreens';
import { AddCashScreen } from './screens/AddCashScreen';
import { BudgetEditScreen, BudgetScreen } from './screens/BudgetScreens';
import { HomeScreen } from './screens/HomeScreen';
import { LoansScreen } from './screens/LoansScreen';
import { MoneyScreen } from './screens/MoneyScreen';
import { PeopleScreen, PersonDetailScreen } from './screens/PeopleScreens';
import {
  AutoCategorizationScreen,
  CategoriesScreen,
  FailedParsesScreen,
  NotificationHistoryScreen,
  NotificationSettingsScreen,
  ProfilesScreen,
  SettingsScreen,
} from './screens/SettingsScreens';
import { DriveBackupScreen } from './screens/DriveBackupScreen';
import { SharedGroupScreen, SharedScreen } from './screens/SharedScreens';
import { TransactionDetailScreen } from './screens/TransactionDetailScreen';
import { appLock } from './services/appLock';
import { registerBackgroundTasks } from './services/backgroundTasks';
import { dataChanged } from './services/dataChanged';
import { notificationIntentBus, type NotificationIntent } from './services/notificationIntentBus';
import { notificationService } from './services/notifications';
import { smsConfigService } from './services/smsConfigService';
import { smsService, startSmsListener } from './services/smsService';
import { useData } from './store/dataStore';
import { useSettings, useTheme } from './store/settingsStore';
import { spacing } from './theme/colors';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

type Phase = 'settings' | 'database' | 'profile' | 'patterns' | 'notifications' | 'data' | 'ready';

const PHASE_LABELS: Record<Phase, string> = {
  settings: 'Loading preferences…',
  database: 'Opening local database…',
  profile: 'Preparing your profile…',
  patterns: 'Loading SMS patterns…',
  notifications: 'Setting up notifications…',
  data: 'Loading your transactions…',
  ready: 'Ready',
};

interface BootFailure {
  phase: Phase;
  message: string;
  stack?: string;
}

const TAB_ICONS: Record<keyof TabParamList, string> = {
  Home: 'home',
  Money: 'receipt-long',
  Budget: 'pie-chart',
  Shared: 'groups',
  Settings: 'settings',
};

function Tabs() {
  const colors = useTheme();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
        headerTitleStyle: { color: colors.text, fontWeight: '700' },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarIcon: ({ color, size }) => (
          <MaterialIcons name={TAB_ICONS[route.name] as keyof typeof MaterialIcons.glyphMap} color={color} size={size} />
        ),
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: 'Hisab' }} />
      <Tab.Screen name="Money" component={MoneyScreen} options={{ title: 'Money' }} />
      <Tab.Screen name="Budget" component={BudgetScreen} />
      <Tab.Screen name="Shared" component={SharedScreen} options={{ title: 'Shared' }} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

function RootNavigator() {
  const colors = useTheme();
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
      <Stack.Screen name="TransactionDetail" component={TransactionDetailScreen} options={{ title: 'Transaction' }} />
      <Stack.Screen name="Accounts" component={AccountsScreen} />
      <Stack.Screen name="AccountDetail" component={AccountDetailScreen} options={{ title: 'Account' }} />
      <Stack.Screen name="AddAccount" component={AddAccountScreen} options={{ title: 'Add account' }} />
      <Stack.Screen name="ScanAccount" component={ScanAccountScreen} options={{ title: 'Scan account QR' }} />
      <Stack.Screen name="AddCash" component={AddCashScreen} options={{ title: 'Cash transaction' }} />
      <Stack.Screen name="Loans" component={LoansScreen} options={{ title: 'Loans & debts' }} />
      <Stack.Screen name="Categories" component={CategoriesScreen} />
      <Stack.Screen name="AutoCategorization" component={AutoCategorizationScreen} options={{ title: 'Auto-categorization' }} />
      <Stack.Screen name="Profiles" component={ProfilesScreen} />
      <Stack.Screen name="FailedParses" component={FailedParsesScreen} options={{ title: 'Failed SMS parses' }} />
      <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} options={{ title: 'Notifications' }} />
      <Stack.Screen name="NotificationHistory" component={NotificationHistoryScreen} options={{ title: 'Notification history' }} />
      <Stack.Screen name="SharedGroup" component={SharedGroupScreen} options={{ title: 'Group' }} />
      <Stack.Screen name="BudgetEdit" component={BudgetEditScreen} options={{ title: 'Budget' }} />
      <Stack.Screen name="People" component={PeopleScreen} />
      <Stack.Screen name="PersonDetail" component={PersonDetailScreen} options={{ title: 'Person' }} />
      <Stack.Screen name="DriveBackup" component={DriveBackupScreen} options={{ title: 'Google Drive backup' }} />
    </Stack.Navigator>
  );
}

async function handleIntent(intent: NotificationIntent): Promise<void> {
  switch (intent.type) {
    case 'categorizeTransaction':
      if (navigationRef.isReady()) navigationRef.navigate('TransactionDetail', { reference: intent.reference });
      return;
    case 'quickCategorizeTransaction': {
      const tx = await transactionRepository.getTransactionByReference(intent.reference);
      if (!tx) return;
      await transactionRepository.updateTransactionCategories([
        makeTransaction({ ...tx, categoryId: intent.categoryId, categoryIds: [intent.categoryId] }),
      ]);
      await notificationService.dismissTransactionNotification(tx).catch(() => undefined);
      dataChanged.notify();
      return;
    }
    case 'openSharedExpenses': {
      if (!navigationRef.isReady()) return;
      const groupId = intent.groupId ? Number.parseInt(intent.groupId, 10) : NaN;
      if (Number.isFinite(groupId)) navigationRef.navigate('SharedGroup', { groupId });
      else navigationRef.navigate('Tabs', { screen: 'Shared' });
      return;
    }
    case 'openLoanDebt':
      if (navigationRef.isReady()) navigationRef.navigate('Loans', { reference: intent.reference });
      return;
    case 'openAccountReparseResult':
      if (navigationRef.isReady()) navigationRef.navigate('Accounts');
      return;
  }
}

/** Everything that must happen before the UI can read data; mirrors the Flutter bootstrap order. */
async function bootstrap(setPhase: (phase: Phase) => void): Promise<void> {
  setPhase('settings');
  await useSettings.getState().load();

  setPhase('database');
  await getDb();

  setPhase('profile');
  await profileRepository.ensureDefaultProfile();

  setPhase('patterns');
  try {
    await smsConfigService.initializePatterns();
  } catch (error) {
    // Patterns can be refreshed later from Settings; the app is usable without them.
    if (__DEV__) console.warn('debug: Pattern initialization failed', error);
  }

  setPhase('notifications');
  try {
    await notificationService.initialize();
    await notificationService.requestPermissions();
  } catch (error) {
    if (__DEV__) console.warn('debug: Notification setup failed', error);
  }

  setPhase('data');
  await useData.getState().refresh();
  const error = useData.getState().error;
  if (error) throw new Error(error);
}

/** Work that should not block the first frame: SMS permissions, listener, catch-up, background tasks. */
async function startBackgroundServices(): Promise<() => void> {
  let unsubscribe: () => void = () => undefined;
  if (Platform.OS === 'android') {
    try {
      const granted = await requestSmsPermission();
      if (granted) {
        unsubscribe = startSmsListener(() => dataChanged.notify());
        const result = await smsService.syncMissedBankSmsSinceLastCatchup();
        if (result.added > 0) dataChanged.notify();
        if (!(await smsService.hasImportedAllBankHistory())) {
          // One pass over the whole inbox finds every account, labeled or not.
          void smsService.syncAllBankHistory().catch((error) => {
            if (__DEV__) console.warn('debug: Bank SMS history import failed', error);
          });
        }
      }
    } catch (error) {
      if (__DEV__) console.warn('debug: SMS setup failed', error);
    }
  }
  await registerBackgroundTasks();
  try {
    await notificationService.emitLaunchIntentIfAny();
  } catch (error) {
    if (__DEV__) console.warn('debug: Launch intent failed', error);
  }
  return unsubscribe;
}

function BootScreen(props: { phase: Phase }) {
  const colors = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: colors.background }]}>
      <Text style={[styles.brand, { color: colors.primary }]}>Hisab</Text>
      <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
      <Text style={{ color: colors.textSecondary, marginTop: spacing.md }}>{PHASE_LABELS[props.phase]}</Text>
    </View>
  );
}

function RecoveryScreen(props: { failure: BootFailure; onRetry: () => void }) {
  const colors = useTheme();
  const [copied, setCopied] = useState(false);
  const diagnostics = useMemo(
    () =>
      [
        `phase: ${props.failure.phase}`,
        `platform: ${Platform.OS} ${String(Platform.Version)}`,
        `error: ${props.failure.message}`,
        props.failure.stack ? `stack:\n${props.failure.stack}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    [props.failure],
  );
  return (
    <View style={[styles.center, { backgroundColor: colors.background, padding: spacing.xl }]}>
      <Icon name="error-outline" size={48} color={colors.expense} />
      <Text style={[styles.recoveryTitle, { color: colors.text }]}>Hisab couldn't open your local data</Text>
      <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: spacing.sm }}>
        Your data has not been deleted. Try again, and if it keeps failing, copy the diagnostics and share them with
        support.
      </Text>
      <Text style={{ color: colors.textMuted, textAlign: 'center', marginTop: spacing.md }} numberOfLines={4}>
        {props.failure.message}
      </Text>
      <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl }}>
        <Button title="Retry" icon="refresh" onPress={props.onRetry} />
        <Button
          title={copied ? 'Copied' : 'Copy diagnostics'}
          icon="content-copy"
          variant="secondary"
          onPress={() => {
            void Clipboard.setStringAsync(diagnostics).then(() => setCopied(true));
          }}
        />
      </View>
    </View>
  );
}

function LockScreen(props: { onUnlock: () => void }) {
  const colors = useTheme();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const unlock = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const ok = await appLock.authenticate();
    setBusy(false);
    if (ok) props.onUnlock();
    else setFailed(true);
  }, [busy, props]);

  useEffect(() => {
    void unlock();
    // Prompt once when the lock screen appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={[styles.center, { backgroundColor: colors.background, padding: spacing.xl }]}>
      <Icon name="lock" size={56} color={colors.primary} />
      <Text style={[styles.recoveryTitle, { color: colors.text }]}>Hisab is locked</Text>
      <Text style={{ color: colors.textSecondary, marginTop: spacing.sm, textAlign: 'center' }}>
        {failed ? 'Authentication was not completed.' : 'Authenticate to view your finances.'}
      </Text>
      <Button title="Unlock" icon="fingerprint" onPress={() => void unlock()} loading={busy} style={{ marginTop: spacing.xl }} />
    </View>
  );
}

function AppContent() {
  const colors = useTheme();
  const [phase, setPhase] = useState<Phase>('settings');
  const [failure, setFailure] = useState<BootFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [locked, setLocked] = useState<boolean | null>(null);
  const phaseRef = useRef<Phase>('settings');

  useEffect(() => {
    let cancelled = false;
    let stopServices: (() => void) | null = null;
    setFailure(null);
    const update = (p: Phase) => {
      phaseRef.current = p;
      if (!cancelled) setPhase(p);
    };
    (async () => {
      try {
        await bootstrap(update);
        const lockEnabled = await appLock.isEnabled();
        if (cancelled) return;
        setLocked(lockEnabled);
        update('ready');
        stopServices = await startBackgroundServices();
        if (cancelled) stopServices();
      } catch (error) {
        if (__DEV__) console.warn('debug: Bootstrap failed', error);
        if (cancelled) return;
        setFailure({
          phase: phaseRef.current,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    })();
    return () => {
      cancelled = true;
      stopServices?.();
    };
  }, [attempt]);

  // Re-lock whenever the app goes to the background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        void appLock.isEnabled().then((enabled) => {
          if (enabled) setLocked(true);
        });
      } else if (state === 'active') {
        dataChanged.notify();
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (phase !== 'ready') return;
    return notificationIntentBus.subscribe((intent) => {
      void handleIntent(intent).catch((error) => {
        if (__DEV__) console.warn('debug: Failed to handle notification intent', error);
      });
    });
  }, [phase]);

  const navTheme: Theme = useMemo(() => {
    const base = colors.dark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: colors.primary,
        background: colors.background,
        card: colors.surface,
        text: colors.text,
        border: colors.border,
        notification: colors.expense,
      },
    };
  }, [colors]);

  if (failure) return <RecoveryScreen failure={failure} onRetry={() => setAttempt((a) => a + 1)} />;
  if (phase !== 'ready') return <BootScreen phase={phase} />;
  return (
    <>
      <NavigationContainer ref={navigationRef} theme={navTheme}>
        <RootNavigator />
      </NavigationContainer>
      {locked ? (
        <View style={StyleSheet.absoluteFill}>
          <LockScreen onUnlock={() => setLocked(false)} />
        </View>
      ) : null}
    </>
  );
}

export default function App() {
  const colors = useTheme();
  return (
    <SafeAreaProvider>
      <StatusBar style={colors.dark ? 'light' : 'dark'} />
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  brand: { fontSize: 36, fontWeight: '800', letterSpacing: -1 },
  recoveryTitle: { fontSize: 20, fontWeight: '700', marginTop: spacing.lg, textAlign: 'center' },
});
