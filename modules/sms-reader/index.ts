import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';
import { normalizedCodes, senderMatchesCodes } from './senderFilter';

export { normalizeSenderCode, senderMatchesCodes } from './senderFilter';

export interface RawSms {
  id?: string | null;
  address?: string | null;
  body?: string | null;
  /** epoch milliseconds */
  date?: number | null;
  /** Android SMS subscription id, -1 when unknown. */
  subscriptionId?: number | null;
}

export const SMS_HEADLESS_TASK = 'TotalsSmsReceived';

interface Subscription {
  remove(): void;
}

interface SmsReaderNative {
  hasPermission(): boolean;
  getInbox(sinceMs: number, untilMs: number | null): Promise<RawSms[]>;
  /** Missing on native builds made before it was added. */
  getInboxFiltered?(sinceMs: number, untilMs: number | null, senderCodes: string[] | null): Promise<RawSms[]>;
  addListener(event: 'onSmsReceived', listener: (sms: RawSms) => void): Subscription;
}

export interface InboxQuery {
  /**
   * Only return messages whose sender, lowercased with everything but a-z0-9 removed,
   * contains one of these codes (normalized the same way). Null or empty returns everything.
   */
  senderCodes?: readonly string[] | null;
}

const native = Platform.OS === 'android' ? requireOptionalNativeModule<SmsReaderNative>('SmsReader') : null;

export function isSmsSupported(): boolean {
  return native != null;
}

export function hasSmsPermission(): boolean {
  try {
    return native?.hasPermission() ?? false;
  } catch {
    return false;
  }
}

export async function requestSmsPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const result = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.READ_SMS,
    PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
  ]);
  return (
    result[PermissionsAndroid.PERMISSIONS.READ_SMS] === PermissionsAndroid.RESULTS.GRANTED &&
    result[PermissionsAndroid.PERMISSIONS.RECEIVE_SMS] === PermissionsAndroid.RESULTS.GRANTED
  );
}

/**
 * Reads inbox messages with `sinceMs <= date <= untilMs`, newest first. With
 * `query.senderCodes`, only messages from matching senders are returned; the native
 * side filters them so other SMS never cross the bridge (older native builds filter here).
 */
export async function getInbox(sinceMs: number, untilMs?: number | null, query?: InboxQuery | null): Promise<RawSms[]> {
  if (!native) return [];
  const codes = normalizedCodes(query?.senderCodes);
  try {
    if (!codes) return await native.getInbox(sinceMs, untilMs ?? null);
    if (typeof native.getInboxFiltered === 'function') {
      return await native.getInboxFiltered(sinceMs, untilMs ?? null, codes);
    }
    const all = await native.getInbox(sinceMs, untilMs ?? null);
    return all.filter((sms) => senderMatchesCodes(sms.address, codes));
  } catch {
    return [];
  }
}


export function addSmsListener(listener: (sms: RawSms) => void): Subscription {
  if (!native) return { remove() {} };
  return native.addListener('onSmsReceived', listener);
}
