/**
 * Foreground triggers for automatic sync: once when the app opens, and (Drive "after changes")
 * a debounced sync after data changes. The periodic background task covers the rest.
 */
import { runAutoD1Sync, isD1SyncRunning } from './d1Sync';
import { dataChanged } from './dataChanged';
import { isDriveSyncRunning, runAutoDriveSync } from './driveSync';

const CHANGE_DEBOUNCE_MS = 2 * 60 * 1000;

async function runAll(trigger: 'open' | 'changes'): Promise<void> {
  try {
    await runAutoDriveSync(trigger);
  } catch (error) {
    if (__DEV__) console.warn('debug: Automatic Drive sync failed', error);
  }
  if (trigger !== 'open') return;
  try {
    await runAutoD1Sync();
  } catch (error) {
    if (__DEV__) console.warn('debug: Automatic D1 sync failed', error);
  }
}

/** Starts the triggers; returns a function that stops them. */
export function startCloudAutoSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  void runAll('open');
  const unsubscribe = dataChanged.subscribe(() => {
    // A sync's own import raises the signal; don't let it schedule another sync.
    if (isDriveSyncRunning() || isD1SyncRunning()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runAll('changes');
    }, CHANGE_DEBOUNCE_MS);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
