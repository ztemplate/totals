import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, View } from 'react-native';
import { confirm, showError } from '../components/dialogs';
import { Button, Card, ListRow, Screen, SectionTitle, TextField, ToggleRow, styles as ui } from '../components/ui';
import {
  clearD1Token,
  getD1State,
  resetD1SyncProgress,
  saveD1Settings,
  saveD1Token,
  setD1AutoSync,
  syncD1Now,
  testD1Connection,
  type D1SyncResultSummary,
  type D1SyncState,
} from '../services/d1Sync';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { formatDateTime } from '../utils/format';

type Busy = 'save' | 'token' | 'test' | 'sync' | 'reset' | null;

function describeResult(result: D1SyncResultSummary): string {
  const parts = [`Uploaded ${result.pushed} change${result.pushed === 1 ? '' : 's'}`];
  if (result.deleted > 0) parts.push(`${result.deleted} deletion${result.deleted === 1 ? '' : 's'}`);
  if (result.imported && result.pulled > 0) {
    const i = result.imported;
    parts.push(
      `received ${result.pulled} record${result.pulled === 1 ? '' : 's'}: added ${i.transactions} transactions, ${i.accounts} accounts, ${i.budgets} budgets, ${i.categories} categories`,
    );
  } else {
    parts.push('nothing new from other devices');
  }
  if (result.skippedDeletions > 0) {
    parts.push(`${result.skippedDeletions} deletions held back because most data disappeared at once`);
  }
  return parts.join(' · ');
}

export function D1SyncScreen() {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const [state, setState] = useState<D1SyncState | null>(null);
  const [accountId, setAccountId] = useState('');
  const [databaseId, setDatabaseId] = useState('');
  const [namespace, setNamespace] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<Busy>(null);

  useEffect(() => {
    void getD1State().then((current) => {
      setState(current);
      setAccountId(current.accountId);
      setDatabaseId(current.databaseId);
      setNamespace(current.namespace);
    });
  }, []);

  const run = async (action: Busy, title: string, task: () => Promise<void>) => {
    setBusy(action);
    try {
      await task();
    } catch (error) {
      showError(title, error);
    } finally {
      setBusy(null);
      setState(await getD1State());
    }
  };

  if (!state) {
    return (
      <Screen>
        <ActivityIndicator color={colors.primary} />
      </Screen>
    );
  }

  const fieldsDirty =
    accountId.trim() !== state.accountId || databaseId.trim() !== state.databaseId || namespace.trim() !== state.namespace;

  const saveFields = () => saveD1Settings({ accountId, databaseId, namespace });

  const save = () =>
    void run('save', 'Cloudflare D1', async () => {
      await saveFields();
    });

  const saveToken = () =>
    void run('token', 'Cloudflare D1', async () => {
      await saveD1Token(token);
      setToken('');
    });

  const clearToken = async () => {
    const ok = await confirm('Remove API token', 'The token is deleted from this phone and auto sync is turned off.', 'Remove', true);
    if (!ok) return;
    await run('token', 'Cloudflare D1', async () => {
      await clearD1Token();
    });
  };

  const test = () =>
    void run('test', 'Connection failed', async () => {
      if (fieldsDirty) await saveFields();
      const info = await testD1Connection();
      Alert.alert(
        'Connected',
        `Tables are ready. "${(await getD1State()).effectiveNamespace}" holds ${info.records} records from ${info.devices} device${info.devices === 1 ? '' : 's'}.`,
      );
    });

  const sync = () =>
    void run('sync', 'Sync failed', async () => {
      if (fieldsDirty) await saveFields();
      const result = await syncD1Now();
      Alert.alert('Cloudflare D1 sync', describeResult(result));
    });

  const reset = async () => {
    const ok = await confirm(
      'Full resync',
      'The next sync uploads everything on this phone again and downloads the whole namespace. Nothing is deleted.',
      'Reset',
    );
    if (!ok) return;
    await run('reset', 'Cloudflare D1', async () => {
      await resetD1SyncProgress();
    });
  };

  const disabled = busy !== null;

  return (
    <Screen>
      <Card style={{ gap: spacing.sm }}>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          Sync your devices through a D1 database in your own Cloudflare account. Each device uploads what changed and merges
          in what the others uploaded. Merging only adds: nothing on this phone is overwritten or deleted by a sync.
        </Text>
        <ListRow
          title={state.lastSyncAt ? `Last sync ${formatDateTime(new Date(state.lastSyncAt), calendar)}` : 'Not synced yet'}
          subtitle={state.lastResult ? describeResult(state.lastResult) : state.configured ? 'Tap Sync now to start.' : 'Fill in the settings below.'}
          icon={state.lastError ? 'sync-problem' : 'sync'}
          iconColor={state.lastError ? colors.expense : undefined}
        />
        {state.lastError ? <Text style={{ color: colors.expense }}>Last sync failed: {state.lastError}</Text> : null}
        <View style={[ui.rowWrap, { gap: spacing.sm }]}>
          <Button title="Sync now" icon="sync" onPress={sync} loading={busy === 'sync'} disabled={disabled || !state.configured} />
          <Button
            title="Test connection"
            variant="secondary"
            onPress={test}
            loading={busy === 'test'}
            disabled={disabled || !state.tokenSaved || !accountId.trim() || !databaseId.trim()}
          />
        </View>
        <ToggleRow
          title="Auto sync"
          subtitle="When the app opens and from the background task (about hourly)"
          icon="autorenew"
          value={state.autoSync}
          disabled={disabled || !state.configured}
          onValueChange={(value) => void setD1AutoSync(value).then(setState)}
        />
      </Card>

      <SectionTitle title="Connection" />
      <Card style={{ gap: spacing.sm }}>
        <TextField
          label="Account ID"
          value={accountId}
          onChangeText={setAccountId}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="32-character account ID"
        />
        <TextField
          label="Database ID"
          value={databaseId}
          onChangeText={setDatabaseId}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        />
        <TextField
          label="Sync namespace"
          value={namespace}
          onChangeText={setNamespace}
          autoCorrect={false}
          placeholder={`Default: active profile (${state.effectiveNamespace})`}
        />
        <Text style={[styles.label, { color: colors.textMuted }]}>
          Devices using the same namespace share data. Use different names to keep profiles apart in one database.
        </Text>
        <Button title="Save" variant="secondary" compact onPress={save} loading={busy === 'save'} disabled={disabled || !fieldsDirty} />

        <TextField
          label={state.tokenSaved ? 'API token (saved)' : 'API token'}
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder={state.tokenSaved ? '•••••••• saved — paste a new one to replace' : 'Paste the API token'}
        />
        <View style={[ui.rowWrap, { gap: spacing.sm }]}>
          <Button
            title={state.tokenSaved ? 'Replace token' : 'Save token'}
            variant="secondary"
            compact
            onPress={saveToken}
            loading={busy === 'token'}
            disabled={disabled || !token.trim()}
          />
          {state.tokenSaved ? (
            <Button title="Remove token" variant="ghost" compact onPress={() => void clearToken()} disabled={disabled} />
          ) : null}
        </View>
        <Text style={[styles.label, { color: colors.textMuted }]}>The token is kept in the phone's secure storage.</Text>
      </Card>

      <SectionTitle title="Cloudflare setup" />
      <Card style={{ gap: spacing.sm }}>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          1. In the Cloudflare dashboard open Storage & Databases → D1 and create a database. Copy its database ID.{'\n'}
          2. Copy your account ID (shown on the account home page and in the dashboard URL).{'\n'}
          3. Under My Profile → API Tokens, create a custom token with the permission Account → D1 → Edit, limited to this
          account.{'\n'}
          4. Enter all three here and tap Test connection. The app creates its tables (hisab_records and hisab_sync_meta)
          itself.{'\n'}
          Deleting something here stops it from reaching new devices, but devices that already have it keep their copy.
        </Text>
        <View style={[ui.rowWrap, { gap: spacing.sm }]}>
          <Button
            title="Open dashboard"
            variant="ghost"
            compact
            onPress={() => void Linking.openURL('https://dash.cloudflare.com/?to=/:account/workers/d1')}
          />
          <Button
            title="Create token"
            variant="ghost"
            compact
            onPress={() => void Linking.openURL('https://dash.cloudflare.com/profile/api-tokens')}
          />
          <Button title="Full resync" variant="ghost" compact onPress={() => void reset()} loading={busy === 'reset'} disabled={disabled} />
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 14, lineHeight: 20 },
  label: { fontSize: 12 },
});
