import type { ImageSourcePropType } from 'react-native';

// Images are copied from the Flutter project by `bun scripts/copy-assets.ts` (runs on postinstall).
const images: Record<string, ImageSourcePropType> = {
  'assets/images/cbe.png': require('../../assets/images/cbe.png'),
  'assets/images/awash.png': require('../../assets/images/awash.png'),
  'assets/images/boa.png': require('../../assets/images/boa.png'),
  'assets/images/dashen.png': require('../../assets/images/dashen.png'),
  'assets/images/zemen.png': require('../../assets/images/zemen.png'),
  'assets/images/telebirr.png': require('../../assets/images/telebirr.png'),
  'assets/images/nib.png': require('../../assets/images/nib.png'),
  'assets/images/mpesa.png': require('../../assets/images/mpesa.png'),
  'assets/images/amhara.png': require('../../assets/images/amhara.png'),
  'assets/images/ahadu.png': require('../../assets/images/ahadu.png'),
  'assets/images/berhan.png': require('../../assets/images/berhan.png'),
  'assets/images/hibret.png': require('../../assets/images/hibret.png'),
  'assets/images/apollo.png': require('../../assets/images/apollo.png'),
  'assets/images/cbe-birr.png': require('../../assets/images/cbe-birr.png'),
  'assets/images/cash.png': require('../../assets/images/cash.png'),
};

export function bankImage(path: string | null | undefined): ImageSourcePropType | undefined {
  if (!path) return undefined;
  return images[path] ?? images[`assets/images/${path.split('/').pop()}`];
}
