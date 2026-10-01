import * as LocalAuthentication from 'expo-local-authentication';
import { prefs, PrefKeys } from './prefs';

export interface AppLockAvailability {
  hasHardware: boolean;
  isEnrolled: boolean;
}

export const appLock = {
  async isEnabled(): Promise<boolean> {
    return prefs.getBool(PrefKeys.appLockEnabled, false);
  },

  async getAvailability(): Promise<AppLockAvailability> {
    try {
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      return { hasHardware, isEnrolled };
    } catch (error) {
      if (__DEV__) console.warn('debug: Failed to read biometric availability', error);
      return { hasHardware: false, isEnrolled: false };
    }
  },

  /** Device credential (PIN/pattern) is accepted as a fallback, matching local_auth defaults. */
  async authenticate(reason = 'Unlock Totals'): Promise<boolean> {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      return result.success;
    } catch (error) {
      if (__DEV__) console.warn('debug: Authentication failed', error);
      return false;
    }
  },

  /** Enabling requires a successful authentication so the user cannot lock themselves out. */
  async setEnabled(enabled: boolean): Promise<boolean> {
    if (enabled) {
      const availability = await this.getAvailability();
      if (!availability.hasHardware && !availability.isEnrolled) {
        const security = await LocalAuthentication.getEnrolledLevelAsync().catch(
          () => LocalAuthentication.SecurityLevel.NONE,
        );
        if (security === LocalAuthentication.SecurityLevel.NONE) return false;
      }
      if (!(await this.authenticate('Confirm to enable app lock'))) return false;
    }
    await prefs.setBool(PrefKeys.appLockEnabled, enabled);
    return true;
  },
};
