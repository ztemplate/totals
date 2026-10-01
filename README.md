# Hisab (React Native)

This is a React Native port of the Flutter budget app in `../totals`, published under its own name so it can be installed next to the original. Its Android package is `com.hisab.budget` and its link scheme is `hisab://`. It is built with Expo SDK 54 and TypeScript, and uses bun as the package manager and script runner.

SMS reading only works on Android, so the app targets Android only. It needs a development build because it ships a native module and won't run in Expo Go.

## Setup

```bash
cd totals-rn
bun install            # also runs scripts/copy-assets.ts (copies images, banks.json, sms_patterns.json from ../totals/app/assets)
bunx expo prebuild --platform android
bunx expo run:android  # builds and installs the dev client on a device/emulator
```

After that, `bun start` runs Metro for the installed dev client.

| Script | What it does |
| --- | --- |
| `bun start` | Metro bundler (dev client) |
| `bun run android` | Native build + install |
| `bun run prebuild:android` | Generate the `android/` project |
| `bun run copy-assets` | Re-copy assets from the Flutter project |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | Unit tests in `tests/` (bun test runner) |

## Features

- **SMS parsing**
  - Reads bank SMS messages through the native `modules/sms-reader` module. A broadcast receiver and the `TotalsSmsReceived` headless JS task handle messages that arrive while the app is closed.
  - Parses messages with the same regex pattern set as the Flutter app (`sms_patterns.json`). Patterns can be refreshed remotely and are cached locally.
  - Skips duplicates. Messages that fail to parse are saved to a *Failed parses* list, where you can retry, copy or delete them.
  - Runs a catch-up sync at startup and in a background task. The settings screen has a manual "sync today" action.
- **Accounts**
  - Supports the bank accounts from `banks.json` plus cash. You can add accounts manually or by scanning a QR code.
  - Shows per-account detail with transactions and balances, and a hide-balances toggle.
- **Transactions**: home and money views, a transaction detail screen, adding cash transactions, and categorizing, editing and deleting transactions.
- **Categories**
  - Comes with built-in expense and income categories. You can add your own with an icon, a colour and a description.
  - Categories can be flagged as essential, main income or recurring.
- **Auto categorization**
  - Learns counterparty → category rules separately for expenses and income. A rule can point to several categories, with one marked primary.
  - Asks you to categorize new counterparties. The prompt can be dismissed per counterparty, and you can manage rules and dismissals in Settings.
- **Budgets**: budgets per category and per period, with progress, on either the Gregorian or the Ethiopian calendar.
- **Loans and debts**: tracks money lent and borrowed, with reminder notifications.
- **People** (Settings → People)
  - Groups transactions by person. One person can have several accounts across banks (CBE, telebirr, …).
  - Transactions are matched by saved account or phone numbers (masked numbers like `1000****1234` work too), then by the counterparty name each bank prints. A name can be saved for one bank or for any bank.
  - The *Person* row on a transaction lets you assign it by hand or mark it as nobody, and can remember that name for future messages.
  - A person's page shows money sent and received, net, their loans and debts, what they owe you and what you owe them, and suggested unmatched counterparties to link.
- **Shared expenses**: groups with members and split expenses. These are stored locally only (see below).
- **Profiles**: multiple profiles, each with its own data, and switching between them.
- **Notifications**
  - Transaction alerts with quick-categorize actions.
  - Daily, weekly and monthly spending summaries at a time you set.
  - Notification history and a test notification for each type.
- **App lock**: biometric or device-credential lock through `expo-local-authentication`.
- **Backup**: exports and imports a JSON backup through the share sheet and document picker. Settings also has a danger-zone reset.
- **Appearance**: light, dark or system theme, and a choice of calendar.

## Layout

```
index.ts                entry point; defines background/headless tasks, then mounts App
modules/sms-reader/     local Expo module (Kotlin): read inbox, permission, SMS broadcast receiver
scripts/copy-assets.ts  copies assets from the Flutter app
src/
  App.tsx               boot sequence (settings → db → profile → patterns → notifications → data),
                        recovery screen, lock screen, SMS listener, notification routing
  components/           shared UI (ui.tsx, finance.tsx, people.tsx, dialogs.ts)
  data/                 bundled bank list (offline fallback for banks.json)
  db/                   SQLite schema + migrations (expo-sqlite)
  models/               types + JSON mapping (transaction, account, bank, category, smsPattern, …)
  repositories/         data access: accounts, banks, transactions, categories, profiles, people, failed parses, …
  services/             smsService, smsConfigService, autoCategorization, notifications,
                        notificationSettings, appLock, backup, spendingSummary, backgroundTasks, dataChanged
  store/                zustand stores (dataStore, settingsStore)
  navigation/           typed routes and navigation helpers
  screens/              Home, Money, Budget, Shared, Accounts, AddCash, Loans, People, TransactionDetail, Settings…
  theme/                colours, spacing
  utils/                pattern parser, sender matching, person matching, duplicate detection, Ethiopian calendar, periods, formatting
tests/                  bun unit tests (SMS parsing, sender matching, person matching, calendar/periods)
```

## Not ported (yet)

- Remote sync for shared expenses. Groups and splits are local only.
- The Android home-screen widget.
- Re-parsing an account's whole SMS history from the account screen.
- Telegram/data sync and the local HTTP server feature.
- The fallback (heuristic) SMS parser. Only the pattern-based parser is ported.
- The "Wrapped" and insights screens.
