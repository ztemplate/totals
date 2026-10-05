/**
 * Backups in the hidden app folder (appDataFolder) of the user's own Google Drive. Only the
 * drive.appdata scope is requested, so the app cannot see any other Drive file and no server of
 * ours is involved. Sign-in is OAuth 2.0 with PKCE in the system browser; the OAuth client ID is
 * the user's own (see README), the refresh token lives in SecureStore.
 */
import Constants from 'expo-constants';
import { uuid } from 'expo-modules-core';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import {
  backupsToPrune,
  buildAuthUrl,
  buildMultipartBody,
  encodeQuery,
  GOOGLE_TOKEN_ENDPOINT,
  parseRedirect,
  sha256,
  toHex,
  utf8Bytes,
} from '../utils/oauthPkce';
import { BACKUP_SCHEMA_VERSION, buildExportJson, importBackupJson, type ImportSummary } from './backup';
import { PrefKeys, prefs } from './prefs';

export type DriveAutoBackup = 'off' | 'daily' | 'weekly';

export interface DriveBackupState {
  /** OAuth client ID from the user's Google Cloud project. */
  clientId: string | null;
  connected: boolean;
  email: string | null;
  keepCount: number;
  autoBackup: DriveAutoBackup;
  lastBackupAt: string | null;
  lastError: string | null;
}

export interface DriveBackupFile {
  id: string;
  name: string;
  size: number;
  createdTime: string | null;
  schemaVersion: number;
  sha256: string | null;
}

export const DRIVE_KEEP_OPTIONS = [3, 5, 10, 20];
const DEFAULT_STATE: DriveBackupState = {
  clientId: null,
  connected: false,
  email: null,
  keepCount: 10,
  autoBackup: 'off',
  lastBackupAt: null,
  lastError: null,
};
const REFRESH_TOKEN_KEY = 'google_drive_refresh_token';
const BACKUP_FORMAT = 'hisab-backup';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS = 'id,name,size,createdTime,appProperties';
const TIMEOUT_MS = 60_000;

let cachedToken: { value: string; expiresAt: number } | null = null;

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function packageName(): string {
  return Constants.expoConfig?.android?.package ?? 'com.hisab.budget';
}

/** Google allows Android OAuth clients to redirect to "<package name>:/oauth2redirect". */
export function driveRedirectUri(): string {
  return `${packageName()}:/oauth2redirect`;
}

export async function getDriveState(): Promise<DriveBackupState> {
  const saved = await prefs.getJson<Partial<DriveBackupState>>(PrefKeys.driveBackup);
  return { ...DEFAULT_STATE, ...saved };
}

async function updateState(patch: Partial<DriveBackupState>): Promise<DriveBackupState> {
  const next = { ...(await getDriveState()), ...patch };
  await prefs.setJson(PrefKeys.driveBackup, next);
  return next;
}

export async function setDriveClientId(clientId: string): Promise<DriveBackupState> {
  const trimmed = clientId.trim();
  const current = await getDriveState();
  // Tokens are tied to the client that issued them.
  if (current.clientId && current.clientId !== trimmed) await disconnectDrive();
  return updateState({ clientId: trimmed || null });
}

export function setDriveKeepCount(keepCount: number): Promise<DriveBackupState> {
  return updateState({ keepCount: Math.max(1, Math.round(keepCount)) });
}

export function setDriveAutoBackup(autoBackup: DriveAutoBackup): Promise<DriveBackupState> {
  return updateState({ autoBackup });
}

function randomString(): string {
  try {
    // Native UUIDs come from a secure random source.
    return `${uuid.v4()}${uuid.v4()}`.replace(/-/g, '');
  } catch {
    let out = '';
    while (out.length < 64) out += Math.random().toString(36).slice(2);
    return out.slice(0, 64);
  }
}

async function withTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DriveError('Google Drive took too long to respond. Try again.')), TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      fetch(input, init).catch(() => {
        throw new DriveError('Could not reach Google. Check your connection.');
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function tokenRequest(params: Record<string, string>): Promise<{ access_token: string; expires_in?: number; refresh_token?: string }> {
  const response = await withTimeout(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeQuery(params),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok || typeof body.access_token !== 'string') {
    if (body.error === 'invalid_grant') throw new DriveError('Google access was revoked. Connect Google Drive again.', 401);
    throw new DriveError(body.error_description || body.error || `Google sign-in failed (HTTP ${response.status}).`, response.status);
  }
  return body as { access_token: string; expires_in?: number; refresh_token?: string };
}

function cacheToken(token: { access_token: string; expires_in?: number }): string {
  cachedToken = { value: token.access_token, expiresAt: Date.now() + Math.max(60, (token.expires_in ?? 3600) - 60) * 1000 };
  return token.access_token;
}

/** Opens Google's consent page and stores the refresh token. Returns false when the user cancels. */
export async function connectDrive(): Promise<boolean> {
  const state = await getDriveState();
  if (!state.clientId) throw new DriveError('Enter your Google OAuth client ID first.');
  const verifier = randomString();
  const nonce = randomString().slice(0, 24);
  const redirectUri = driveRedirectUri();
  const result = await WebBrowser.openAuthSessionAsync(
    buildAuthUrl({ clientId: state.clientId, redirectUri, verifier, state: nonce }),
    redirectUri,
  );
  if (result.type !== 'success') return false;
  const redirect = parseRedirect(result.url);
  if (redirect.error) throw new DriveError(redirect.error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${redirect.error}`);
  if (!redirect.code || redirect.state !== nonce) throw new DriveError('Google sign-in did not complete. Try again.');

  const token = await tokenRequest({
    client_id: state.clientId,
    code: redirect.code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (!token.refresh_token) throw new DriveError('Google did not grant offline access. Try again.');
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token.refresh_token);
  cacheToken(token);

  let email: string | null = null;
  try {
    const about = await driveJson<{ user?: { emailAddress?: string } }>(`${DRIVE}/about?fields=user(emailAddress)`);
    email = about.user?.emailAddress ?? null;
  } catch (error) {
    if (__DEV__) console.warn('debug: Could not read the Drive user', error);
  }
  await updateState({ connected: true, email, lastError: null });
  return true;
}

/** Forgets the Google tokens. Backups stay in Drive. */
export async function disconnectDrive(): Promise<void> {
  const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  cachedToken = null;
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  await updateState({ connected: false, email: null });
  if (refreshToken) {
    // Best effort: also revoke the grant on Google's side.
    withTimeout(`https://oauth2.googleapis.com/revoke?${encodeQuery({ token: refreshToken })}`, { method: 'POST' }).catch(() => undefined);
  }
}

async function accessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const state = await getDriveState();
  const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  if (!state.clientId || !refreshToken) throw new DriveError('Connect Google Drive first.', 401);
  try {
    return cacheToken(await tokenRequest({ client_id: state.clientId, refresh_token: refreshToken, grant_type: 'refresh_token' }));
  } catch (error) {
    if (error instanceof DriveError && error.status === 401) await updateState({ connected: false });
    throw error;
  }
}

function errorFor(status: number, body: Record<string, any>): DriveError {
  const reason: string | undefined = body?.error?.errors?.[0]?.reason;
  if (status === 401) return new DriveError('Google access expired. Connect Google Drive again.', status);
  if (reason === 'storageQuotaExceeded') return new DriveError('Your Google Drive is full. Free up space and try again.', status);
  if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') {
    return new DriveError('The Google Drive API is not enabled in your Google Cloud project.', status);
  }
  if (status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')) {
    return new DriveError('Google Drive is busy. Try again in a minute.', status);
  }
  if (status === 403) return new DriveError('Google Drive refused access. Connect Google Drive again.', status);
  if (status === 404) return new DriveError('This backup is no longer in Google Drive.', status);
  if (status >= 500) return new DriveError('Google Drive is unavailable right now. Try again later.', status);
  return new DriveError(body?.error?.message || `Google Drive request failed (HTTP ${status}).`, status);
}

/** Sends a Drive request, retrying once with a fresh token when the current one is rejected. */
async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(attempt > 0);
    const response = await withTimeout(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
    if (response.ok) return response;
    if (response.status === 401 && attempt === 0) continue;
    throw errorFor(response.status, (await response.json().catch(() => ({}))) as Record<string, any>);
  }
}

async function driveJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await driveFetch(url, init);
  const text = await response.text();
  try {
    return (text.trim() ? JSON.parse(text) : {}) as T;
  } catch {
    throw new DriveError('Google Drive returned an unexpected response.');
  }
}

function fileFromJson(json: Record<string, any>): DriveBackupFile | null {
  const props = (json.appProperties ?? {}) as Record<string, string>;
  if (props.format !== BACKUP_FORMAT || !json.id) return null;
  return {
    id: String(json.id),
    name: String(json.name ?? ''),
    size: Number(json.size) || 0,
    createdTime: props.createdAt || json.createdTime || null,
    schemaVersion: Number(props.schemaVersion) || 0,
    sha256: props.sha256 || null,
  };
}

/** Backups in the app folder, newest first. */
export async function listDriveBackups(): Promise<DriveBackupFile[]> {
  const files: DriveBackupFile[] = [];
  let pageToken: string | null = null;
  do {
    const query: Record<string, string> = {
      spaces: 'appDataFolder',
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      orderBy: 'createdTime desc',
      pageSize: '100',
    };
    if (pageToken) query.pageToken = pageToken;
    const body: { files?: Record<string, any>[]; nextPageToken?: string } = await driveJson(`${DRIVE}/files?${encodeQuery(query)}`);
    for (const json of body.files ?? []) {
      const file = fileFromJson(json);
      if (file) files.push(file);
    }
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return files.sort((a, b) => Date.parse(b.createdTime ?? '') - Date.parse(a.createdTime ?? ''));
}

async function deleteDriveFile(id: string): Promise<void> {
  try {
    await driveFetch(`${DRIVE}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (error) {
    if (!(error instanceof DriveError && error.status === 404)) throw error;
  }
}

export async function deleteDriveBackup(id: string): Promise<void> {
  await deleteDriveFile(id);
}

function backupName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `hisab_backup_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json`;
}

/** Uploads a full export and deletes backups beyond the keep count. */
export async function backUpToDrive(): Promise<DriveBackupFile> {
  try {
    const state = await getDriveState();
    const json = await buildExportJson();
    const createdAt = new Date();
    const metadata = {
      name: backupName(createdAt),
      parents: ['appDataFolder'],
      mimeType: 'application/json',
      appProperties: {
        format: BACKUP_FORMAT,
        schemaVersion: String(BACKUP_SCHEMA_VERSION),
        createdAt: createdAt.toISOString(),
        sha256: toHex(sha256(utf8Bytes(json))),
      },
    };
    const boundary = `hisab_${randomString().slice(0, 24)}`;
    const uploaded = await driveJson<Record<string, any>>(
      `${DRIVE_UPLOAD}/files?${encodeQuery({ uploadType: 'multipart', fields: FILE_FIELDS })}`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: buildMultipartBody(metadata, json, 'application/json', boundary),
      },
    );
    const file = fileFromJson(uploaded);
    if (!file) throw new DriveError('Google Drive did not confirm the uploaded backup.');

    try {
      const existing = await listDriveBackups();
      for (const old of backupsToPrune(existing, state.keepCount)) await deleteDriveFile(old.id);
    } catch (error) {
      if (__DEV__) console.warn('debug: Could not prune old Drive backups', error);
    }
    await updateState({ lastBackupAt: createdAt.toISOString(), lastError: null });
    return file;
  } catch (error) {
    await updateState({ lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Downloads a backup and merges it into local data, like importing a backup file. */
export async function restoreFromDrive(file: DriveBackupFile): Promise<ImportSummary> {
  const response = await driveFetch(`${DRIVE}/files/${encodeURIComponent(file.id)}?alt=media`);
  const json = await response.text();
  if (file.sha256 && toHex(sha256(utf8Bytes(json))) !== file.sha256) {
    throw new DriveError('This backup is damaged (checksum mismatch).');
  }
  return importBackupJson(json);
}

/** Called from the periodic background task. */
export async function runScheduledDriveBackup(now = new Date()): Promise<boolean> {
  const state = await getDriveState();
  if (state.autoBackup === 'off' || !state.connected || !state.clientId) return false;
  const last = state.lastBackupAt ? Date.parse(state.lastBackupAt) : 0;
  const interval = (state.autoBackup === 'daily' ? 1 : 7) * 24 * 60 * 60 * 1000;
  // A little slack so a task that fires slightly early still counts the period as due.
  if (Number.isFinite(last) && now.getTime() - last < interval - 60 * 60 * 1000) return false;
  await backUpToDrive();
  return true;
}
