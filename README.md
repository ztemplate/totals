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
  - **Unlabeled accounts.** Every bank message is parsed and saved once, even before you add an account. Messages no account claims are grouped into *unlabeled accounts*: by the account number printed in the SMS (masked forms are merged), or, for SIM banks like telebirr, by the SIM that received them. They're listed under Money → Accounts with the bank, message count and last balance. Label one and it becomes a normal account that claims its stored messages, with no re-parse. Adding an account by hand claims matching stored messages the same way.
  - **Scanning bank SMS.** Money → Accounts has a *Bank SMS* card. *Scan new messages* reads only what arrived since the last scan (shown on the card). *Date range* reads a chosen period. *Full re-scan* reads the whole inbox again. Already imported messages are skipped. After every scan the app re-checks which account owns each message and sets each account's balance from its newest message. *Recheck balances & owners* does that without reading the inbox.
  - **Which account a message belongs to.** When a message has both a greeting name ("Dear Abebe") and an account number, the account must match both. A message for someone else's account with the same visible digits stays unassigned and shows under *Unlabeled accounts*. If only one of the two is in the message, that one decides. If neither is, or several accounts still fit, the receiving SIM and then the default account decide. An account with no holder name is matched on its number. Editing an account's name or number re-checks its messages. An older balance never overwrites a newer one, so scanning an old date range is safe.
  - **Parsed accounts** (Money → Accounts → *Parsed accounts*, or Settings) lists every account found in the parsed SMS: your registered accounts, unlabeled ones and, under *Counterparties*, the account and phone numbers you paid or were paid by. Each row shows the bank or wallet, the number as printed, the holder name, message count, last balance, first and last seen, and who it belongs to. Filter by *Banks* or *Providers* (SIM wallets such as telebirr and M-Pesa), by bank, by person or *Unassigned*, search, or group the list by person. Tap a row to pick or add its person (saved as that person's account or wallet number, so one person can own many accounts and their page lists them under Details and *Accounts*), open the account, label it, or read its messages with the original SMS text.
- **Transactions**: home and money views, a transaction detail screen, adding cash transactions, and categorizing, editing and deleting transactions. Tapping a transaction in a list expands it with *Categorize*, *Split* and *Details* buttons. The Money tab has *Activity*, *Accounts* and *People* tabs at the top. Activity shows a month at a time, or any date range (presets or two taps on a calendar that follows the Ethiopian or Gregorian setting).
- **Splitting a transaction** (expand a transaction → Split, or transaction detail → Split)
  - The editor is a list of entries with *Add entry* at the bottom. Each entry has an amount, a *Category* button and a *Person* button. The person defaults to *Me*; choosing someone else makes that part a loan to them (a debt, for money received). Whatever isn't split off stays with the parent's categories.
  - At the top, *Split equally into 2–6* sets the number of equal parts, keeping the people and categories already chosen. *Split with group* fills one equal part for you (optional) and one for each member of a saved group.
  - Budgets, category filters and summaries count your parts in their own categories. Parts for other people aren't counted as your spending; they keep their category so you can see what the money was for. Each is a loan (keyed `<parent>#split-<id>`) that you mark as paid or pending.
- **ATM cash pockets**: an ATM withdrawal is mirrored into the Cash wallet as a transfer to your pocket. Cash spending can be attached to the withdrawal it came from, and the withdrawal shows how much is spent and how much is left.
- **Categories**
  - Comes with built-in expense and income categories. You can add your own with an icon, a colour and a description.
  - Categories can be flagged as essential, main income or recurring.
  - Categories can be grouped: any category (built-ins too) can sit under a major category of the same flow, from the *Parent category* picker or *+* on a category in Settings → Categories, where they show as a collapsible tree. Deleting a parent moves its subcategories up a level. Pickers list subcategories under their parent as "Parent › Child".
  - Budget → Categories shows totals per category for this month or year: each major category's total includes its subcategories, with each subcategory's own total beneath it. Filtering Money by a major category and budgets on a major category include its subcategories too.
- **Auto categorization**
  - Learns counterparty → category rules separately for expenses and income. A rule can point to several categories, with one marked primary.
  - Asks you to categorize new counterparties. The prompt can be dismissed per counterparty, and you can manage rules and dismissals in Settings.
- **Budgets** (Budget tab: *Budgets*, *Categories*, *Planned*, *Income*)
  - Budgets per category and per period, with progress.
  - **Planned** lists things you plan to buy, each a *must*, *need* or *want*, with a price, an optional needed-by date, money already saved and a note. The money you have is handed out musts first, then needs, then wants (earliest date first), and the summary shows how much you are short for each tier and in total. A toggle also counts certain or likely income still to come this year. Bought items move to a *Bought* list.
  - **Income** has three parts:
    - *Expected income*: one-time or recurring (weekly, every 2 weeks, monthly, every 3 months, yearly) with a first and optional last payment and a certainty. It shows what you will make this year, what is already due and what is still to come. "This year" follows the calendar setting: Meskerem 1 to the end of Pagume, or January to December. On the Ethiopian calendar monthly income is paid in the 12 thirty-day months and skips Pagume.
    - *Assets*: estimated worth and how fast each could be sold (cash, days, weeks, months, hard). Totals show the full worth, a quick-sale value (100/95/85/70/50% by liquidity) and what you could raise within about a week.
    - *Ways to earn*: ideas with a reward, the hours they take, how hard those hours are (1–5) and the chance they pay off. They are ranked by expected money per effort-hour (reward × chance ÷ (hours × 1–2 for strain)) and compared with what an ordinary hour of yours earns (regular yearly income ÷ 2,080 h). Small, likely ideas are marked *Quick win*.
- **Loans and debts**: tracks money lent and borrowed, with reminder notifications.
- **People** (Money → People)
  - Groups transactions by person. One person can have several accounts across banks (CBE, telebirr, …) and phone numbers.
  - Each person has a type (friend, family, shop, restaurant, cafe, service, work, other) and optional email, address and Telegram handle (kept for the planned Telegram bot).
  - *Details* on a person's page lists their phone numbers, bank account numbers (with the bank), email, address and Telegram. Tap one to copy it. Numbers added there also match their messages.
  - *Groups* (People → Groups) are saved lists of people, like flatmates or a team, used by *Split with group*.
  - *Insights* shows where your money goes (top people and spending per type), who borrows the most and still owes, and who you deal with most. It can be limited to a period.
  - Transactions are matched by saved account or phone numbers (masked numbers like `1000****1234` work too), then by the counterparty name each bank prints. A name can be saved for one bank or for any bank.
  - The *Person* row on a transaction lets you assign it by hand or mark it as nobody, and can remember that name for future messages.
  - A person's page shows money sent and received, net, their loans and debts, what they owe you and what you owe them, their transactions by day, and (collapsed by default) suggested unmatched counterparties to link.
- **Shared expenses**: groups with members and split expenses. These are stored locally only (see below).
- **Profiles**: multiple profiles, each with its own data, and switching between them.
- **Notifications**
  - Transaction alerts with quick-categorize actions.
  - Daily, weekly and monthly spending summaries at a time you set.
  - Notification history and a test notification for each type.
- **App lock**: biometric or device-credential lock through `expo-local-authentication`.
- **Backup**
  - Exports and imports a JSON backup through the share sheet and document picker. Backups include splits, cash links, people, people groups, planned items, expected income, assets and ways to earn. Settings also has a danger-zone reset.
  - **Google Drive sync** (Settings → Google Drive sync) uploads the same backup to the hidden app-data folder of your own Drive. No server of ours is involved, and the app can't see any other Drive file. It supports backing up now, automatic daily or weekly backups from the background task, keeping the newest 3/5/10/20, and restore (verified by checksum, merged like an import) or delete.
    - *Sync now* syncs devices that share the Drive account. Each snapshot records a per-install device id and name in its Drive `appProperties`. Sync downloads the newest snapshot of every other device that hasn't been merged yet, merges it like an import, uploads a fresh snapshot of this device and prunes to the keep count. Pruning never removes a device's newest snapshot. Merging only adds data and skips duplicates. Nothing local is overwritten or deleted, and edits or deletions of records the other device already has don't carry over.
    - *Auto sync* can be off, *on app open*, or *after changes* (debounced by about 2 minutes, at most every 10 minutes, and also when the app returns to the foreground). When it's on, the background task also syncs every 6 hours or so. The screen shows the last sync time, what was merged, and the last error.
  - **Cloudflare D1 sync** (Settings → Cloudflare D1 sync) syncs devices through a D1 database in your own Cloudflare account. See [Cloudflare D1 setup](#cloudflare-d1-setup).
- **Appearance**: light, dark or system theme, and a choice of calendar. On the Ethiopian calendar everything follows it: month navigation and labels (Meskerem, Tikimt, …, Pagume with its 5 or 6 days), monthly spending on Home, budgets, monthly summary notifications, people insights, yearly income and every date picker.

## Google Drive setup

Drive sign-in uses an OAuth client from **your own** Google Cloud project, so no client secret ships with the app:

1. Create a project at <https://console.cloud.google.com> and enable the **Google Drive API**.
2. Configure the OAuth consent screen. Add the scope `https://www.googleapis.com/auth/drive.appdata` and add yourself as a test user (or publish the app).
3. Create an OAuth client ID of type **Android**: package `com.hisab.budget`, plus the SHA-1 of the key that signs your build. For debug builds, run `keytool -list -v -keystore android/app/debug.keystore -alias androiddebugkey -storepass android -keypass android`.
4. In the app, open Settings → Google Drive sync, paste the client ID and tap *Connect Google Drive*. The redirect URI is `com.hisab.budget:/oauth2redirect`.

The redirect uses the `com.hisab.budget` URL scheme (in `app.json` and `AndroidManifest.xml`), so rebuild the native app once with `bunx expo run:android` after updating.

## Cloudflare D1 setup

1. In the Cloudflare dashboard, open **Storage & Databases → D1** and create a database. Copy its **database ID**.
2. Copy your **account ID** from the account home page or the dashboard URL.
3. Under **My Profile → API Tokens**, create a custom token with the permission **Account → D1 → Edit**, scoped to that account.
4. In the app, open Settings → Cloudflare D1 sync. Enter the account ID and database ID, then paste and save the token, which is stored in `expo-secure-store`. Tap *Test connection*. It runs `SELECT 1` and creates the tables.
5. Tap *Sync now*, or turn on *Auto sync* to sync when the app opens and from the background task (about hourly).

How it works (`services/d1SyncCore.ts`, `services/d1Sync.ts`):

- The app calls the D1 REST API directly: `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query` with `Authorization: Bearer <token>`. The body is `{ "sql", "params" }`, or `{ "batch": [{ "sql", "params" }, …] }` for several statements in one request.
- There is one generic table: `hisab_records (profile, entity, record_key, data, updated_at, device_id, deleted)` with primary key `(profile, entity, record_key)`. `hisab_sync_meta` lists the devices that have synced. Every list in the backup JSON becomes records keyed by the natural keys the importer uses: transaction reference, category built-in key or name+flow, person name, and so on. Local ids of categories, people and splits are rewritten to ids derived from those keys, so data from different phones lines up.
- *Profile* is a sync namespace. It defaults to the active profile's name. Phones using the same namespace share data, and one database can hold several namespaces.
- Push uploads only records whose content hash changed since the last sync. Upserts are chunked to D1's 100 bound parameters per statement and batched per request. A small local table, `d1_sync_state`, remembers the hashes.
- Pull reads rows from other devices since the last cursor (D1 server time), rebuilds a backup JSON and merges it with the normal import. The merge only adds data, so nothing local is overwritten. A record deleted on one phone becomes a tombstone: new devices don't receive it, and phones that already have it keep their copy. If most data vanishes at once, for example after *Delete all data*, those deletions are held back. *Full resync* re-uploads everything and pulls the whole namespace again.

## Layout

```
index.ts                entry point; defines background/headless tasks, then mounts App
modules/sms-reader/     local Expo module (Kotlin): read inbox, permission, SMS broadcast receiver
scripts/copy-assets.ts  copies assets from the Flutter app
src/
  App.tsx               boot sequence (settings → db → profile → patterns → notifications → data),
                        recovery screen, lock screen, SMS listener, notification routing
  components/           shared UI (ui.tsx, finance.tsx, people.tsx, splits.tsx, transactionActions.tsx, dialogs.ts)
  data/                 bundled bank list (offline fallback for banks.json)
  db/                   SQLite schema + migrations (expo-sqlite)
  models/               types + JSON mapping (transaction, account, bank, category, smsPattern, …)
  repositories/         data access: accounts, banks, transactions, categories, profiles, people, failed parses, …
  services/             smsService, smsConfigService, autoCategorization, notifications,
                        notificationSettings, appLock, backup, driveSync, d1Sync (+ d1SyncCore), cloudAutoSync,
                        spendingSummary, backgroundTasks, dataChanged
  store/                zustand stores (dataStore, settingsStore)
  navigation/           typed routes and navigation helpers
  screens/              Home, Money, Budget (+ Planning), Shared, Accounts, AddCash, Loans, People, TransactionDetail, Settings…
  theme/                colours, spacing
  utils/                pattern parser, sender matching, person matching, duplicate detection, Ethiopian calendar, periods, formatting
tests/                  bun unit tests (SMS parsing, sender matching, person matching, calendar/periods,
                        splits, split editor entries, cash pockets, unlabeled and parsed accounts, account ownership, people analytics, planning, OAuth/PKCE)
```

## Not ported (yet)

- Remote sync for shared expenses. Groups and splits are local only.
- The Android home-screen widget.
- The Telegram bot and mini app. People already have a Telegram handle field for it.
- The local HTTP server feature.
- The fallback (heuristic) SMS parser. Only the pattern-based parser is ported.
- The "Wrapped" and insights screens.
