// Copies binary/large assets from the Flutter app into this project.
// Runs automatically after `bun install`; safe to re-run.
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const flutterAssets = resolve(root, '../totals/app/assets');

const images = [
  'cbe.png',
  'awash.png',
  'boa.png',
  'dashen.png',
  'zemen.png',
  'telebirr.png',
  'nib.png',
  'mpesa.png',
  'amhara.png',
  'ahadu.png',
  'berhan.png',
  'hibret.png',
  'apollo.png',
  'cbe-birr.png',
  'cash.png',
];

function copy(from: string, to: string) {
  if (!existsSync(from)) {
    console.warn(`[copy-assets] missing ${from}`);
    return;
  }
  mkdirSync(resolve(to, '..'), { recursive: true });
  copyFileSync(from, to);
}

if (!existsSync(flutterAssets)) {
  console.warn(`[copy-assets] Flutter assets not found at ${flutterAssets}; skipping.`);
  process.exit(0);
}

for (const name of images) {
  copy(join(flutterAssets, 'images', name), join(root, 'assets/images', name));
}
copy(join(flutterAssets, 'icon/totals_icon.png'), join(root, 'assets/icon/totals_icon.png'));
copy(join(flutterAssets, 'sms_patterns.json'), join(root, 'assets/sms_patterns.json'));
copy(join(flutterAssets, 'banks.json'), join(root, 'assets/banks.json'));

const fallback = join(flutterAssets, 'fallback_sms_patterns.json');
if (existsSync(fallback) && statSync(fallback).isFile()) {
  copy(fallback, join(root, 'assets/fallback_sms_patterns.json'));
}

const copied = existsSync(join(root, 'assets/images'))
  ? readdirSync(join(root, 'assets/images')).length
  : 0;
console.log(`[copy-assets] done (${copied} images)`);
