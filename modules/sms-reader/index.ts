import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';

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
  addListener(event: 'onSmsReceived', listener: (sms: RawSms) => void): Subscription;
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

/** Reads inbox messages with `sinceMs <= date <= untilMs`, newest first. */
export async function getInbox(sinceMs: number, untilMs?: number | null): Promise<RawSms[]> {
  if (!native) return [];
  try {
    return await native.getInbox(sinceMs, untilMs ?? null);
  } catch {
    return [];
  }
}

export function addSmsListener(listener: (sms: RawSms) => void): Subscription {
  if (!native) return { remove() {} };
  return native.addListener('onSmsReceived', listener);
}
