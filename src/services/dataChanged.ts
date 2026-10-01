/**
 * Lightweight signal raised when transactions or accounts change outside of
 * the UI (incoming SMS, background tasks, notification actions). Stores
 * subscribe to reload their data.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export const dataChanged = {
  notify(): void {
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        if (__DEV__) console.warn('debug: data change listener failed', error);
      }
    });
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
