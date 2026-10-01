import { Alert } from 'react-native';

/** Promise-based confirmation dialog. Dismissing the dialog counts as "cancel". */
export function confirm(title: string, message: string, confirmLabel = 'OK', destructive = false): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function showError(title: string, error: unknown): void {
  Alert.alert(title, error instanceof Error ? error.message : String(error));
}
