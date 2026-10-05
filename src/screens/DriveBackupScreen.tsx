import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, View } from 'react-native';
import { confirm, showError } from '../components/dialogs';
import { Button, Card, Chip, Divider, EmptyState, ListRow, Screen, SectionTitle, SegmentedControl, TextField, styles as ui } from '../components/ui';
import {
  backUpToDrive,
  connectDrive,
  deleteDriveBackup,
  disconnectDrive,
  DRIVE_KEEP_OPTIONS,
  driveRedirectUri,
  getDriveState,
  listDriveBackups,
  restoreFromDrive,
  setDriveAutoBackup,
  setDriveClientId,
  setDriveKeepCount,
  type DriveAutoBackup,
  type DriveBackupFile,
  type DriveBackupState,
} from '../services/driveSync';
import { useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { formatDateTime } from '../utils/format';

type Busy = 'connect' | 'backup' | 'list' | `restore:${string}` | `delete:${string}` | null;

const AUTO_OPTIONS: { value: DriveAutoBackup; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function DriveBackupScreen() {
  const colors = useTheme();
  const [state, setState] = useState<DriveBackupState | null>(null);
  const [clientId, setClientId] = useState('');
  const [backups, setBackups] = useState<DriveBackupFile[] | null>(null);
  const [busy, setBusy] = useState<Busy>(null);

  const run = async (action: Busy, title: string, task: () => Promise<void>) => {
    setBusy(action);
    try {
      await task();
    } catch (error) {
      showError(title, error);
    } finally {
      setBusy(null);
      setState(await getDriveState());
    }
  };

  const loadBackups = useCallback(async () => {
    setBusy('list');
    try {
      setBackups(await listDriveBackups());
    } catch (error) {
      setBackups(null);
      showError('Google Drive', error);
    } finally {
      setBusy(null);
      setState(await getDriveState());
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const current = await getDriveState();
      setState(current);
      setClientId(current.clientId ?? '');
      if (current.connected) void loadBackups();
    })();
  }, [loadBackups]);

  if (!state) {
    return (
      <Screen>
        <ActivityIndicator color={colors.primary} />
      </Screen>
    );
  }

  const saveClientId = () =>
    void run(null, 'Google Drive', async () => {
      const next = await setDriveClientId(clientId);
      setClientId(next.clientId ?? '');
      setBackups(null);
    });

  const connect = () =>
    void run('connect', 'Google sign-in', async () => {
      if (clientId.trim() !== (state.clientId ?? '')) await setDriveClientId(clientId);
      if (await connectDrive()) {
        setState(await getDriveState());
        await loadBackups();
      }
    });

  const disconnect = async () => {
    const ok = await confirm(
      'Disconnect Google Drive',
      'Backups already in your Drive are kept. You can connect again any time.',
      'Disconnect',
      true,
    );
    if (!ok) return;
    await run(null, 'Google Drive', async () => {
      await disconnectDrive();
      setBackups(null);
    });
  };

  const backUp = () =>
    void run('backup', 'Backup failed', async () => {
      await backUpToDrive();
      setBackups(await listDriveBackups());
      Alert.alert('Google Drive', 'Backup saved to your Google Drive.');
    });

  const restore = async (file: DriveBackupFile) => {
    const ok = await confirm(
      'Restore backup',
      `Data from the backup of ${file.createdTime ? formatDateTime(new Date(file.createdTime)) : file.name} is added to what you already have. Existing transactions are kept and duplicates are skipped.`,
      'Restore',
    );
    if (!ok) return;
    await run(`restore:${file.id}`, 'Restore failed', async () => {
      const summary = await restoreFromDrive(file);
      Alert.alert(
        'Restore complete',
        `Added ${summary.transactions} transactions, ${summary.accounts} accounts, ${summary.budgets} budgets and ${summary.categories} categories.`,
      );
    });
  };

  const remove = async (file: DriveBackupFile) => {
    const ok = await confirm('Delete backup', 'Delete this backup from Google Drive?', 'Delete', true);
    if (!ok) return;
    await run(`delete:${file.id}`, 'Could not delete', async () => {
      await deleteDriveBackup(file.id);
      setBackups((list) => list?.filter((b) => b.id !== file.id) ?? null);
    });
  };

  const redirectUri = driveRedirectUri();

  return (
    <Screen>
      <Card style={{ gap: spacing.sm }}>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          Backups go to a hidden app folder in your own Google Drive. The app can only see the files it created there, and no
          other server is involved.
        </Text>
        {state.connected ? (
          <>
            <ListRow
              title={state.email ?? 'Connected'}
              subtitle={
                state.lastBackupAt ? `Last backup ${formatDateTime(new Date(state.lastBackupAt))}` : 'No backup yet'
              }
              icon="cloud-done"
            />
            {state.lastError ? <Text style={{ color: colors.expense }}>{state.lastError}</Text> : null}
            <View style={[ui.rowWrap, { gap: spacing.sm }]}>
              <Button title="Back up now" icon="cloud-upload" onPress={backUp} loading={busy === 'backup'} disabled={busy !== null} />
              <Button title="Disconnect" variant="ghost" onPress={() => void disconnect()} disabled={busy !== null} />
            </View>
          </>
        ) : (
          <Button
            title="Connect Google Drive"
            icon="cloud"
            onPress={connect}
            loading={busy === 'connect'}
            disabled={busy !== null || !clientId.trim()}
          />
        )}
      </Card>

      {state.connected ? (
        <>
          <SectionTitle title="Automatic backup" />
          <Card style={{ gap: spacing.md }}>
            <SegmentedControl
              options={AUTO_OPTIONS}
              value={state.autoBackup}
              onChange={(value) => void setDriveAutoBackup(value).then(setState)}
            />
            <Text style={[styles.label, { color: colors.textSecondary }]}>Keep the newest</Text>
            <View style={[ui.rowWrap, { gap: spacing.sm }]}>
              {DRIVE_KEEP_OPTIONS.map((count) => (
                <Chip
                  key={count}
                  label={`${count} backups`}
                  selected={state.keepCount === count}
                  onPress={() => void setDriveKeepCount(count).then(setState)}
                />
              ))}
            </View>
          </Card>

          <SectionTitle
            title="Backups in Drive"
            action={busy === 'list' ? undefined : { label: 'Refresh', onPress: () => void loadBackups() }}
          />
          <Card style={{ paddingVertical: spacing.xs }}>
            {busy === 'list' && !backups ? <ActivityIndicator color={colors.primary} style={{ margin: spacing.md }} /> : null}
            {backups && backups.length === 0 ? (
              <EmptyState icon="cloud-off" title="No backups yet" message="Tap Back up now to save the first one." />
            ) : null}
            {(backups ?? []).map((file, index) => (
              <View key={file.id}>
                {index > 0 ? <Divider /> : null}
                <ListRow
                  title={file.createdTime ? formatDateTime(new Date(file.createdTime)) : file.name}
                  subtitle={`${formatSize(file.size)} · schema v${file.schemaVersion || '?'} · tap to restore, hold to delete`}
                  icon="restore"
                  disabled={busy !== null}
                  onPress={() => void restore(file)}
                  onLongPress={() => void remove(file)}
                  right={
                    busy === `restore:${file.id}` || busy === `delete:${file.id}` ? (
                      <ActivityIndicator color={colors.primary} />
                    ) : undefined
                  }
                />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <SectionTitle title="Google Cloud setup" />
      <Card style={{ gap: spacing.sm }}>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          Drive sign-in uses an OAuth client from your own Google Cloud project, so no shared secret ships with the app. In
          console.cloud.google.com: enable the Google Drive API, add the drive.appdata scope to the consent screen, then create an
          Android OAuth client for package com.hisab.budget with your signing certificate's SHA-1. Paste its client ID below.
        </Text>
        <TextField
          label="OAuth client ID"
          value={clientId}
          onChangeText={setClientId}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="1234-abc.apps.googleusercontent.com"
        />
        <View style={[ui.rowWrap, { gap: spacing.sm }]}>
          <Button
            title="Save"
            variant="secondary"
            compact
            onPress={saveClientId}
            disabled={busy !== null || clientId.trim() === (state.clientId ?? '')}
          />
          <Button
            title="Copy redirect URI"
            variant="ghost"
            compact
            onPress={() => void Clipboard.setStringAsync(redirectUri)}
          />
          <Button
            title="Open console"
            variant="ghost"
            compact
            onPress={() => void Linking.openURL('https://console.cloud.google.com/apis/credentials')}
          />
        </View>
        <Text style={[styles.label, { color: colors.textMuted }]}>Redirect URI: {redirectUri}</Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 14, lineHeight: 20 },
  label: { fontSize: 12 },
});
