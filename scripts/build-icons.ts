/**
 * Rasterizes the vendor logos in assets/icons/*.svg into PNGs the TUI can
 * draw, since OpenTUI's image decoder reads PNG but not SVG. The logos use
 * fill="currentColor", which is replaced by each provider's brand color
 * from the theme so the icons match the dots elsewhere in the UI.
 *
 * The PNGs are committed, so running the TUI never needs this script or
 * its dev dependency. Rerun it after changing an SVG or a brand color:
 *
 *   bun scripts/build-icons.ts
 */
import { Resvg } from '@resvg/resvg-js';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brand } from '../src/theme';

const DIR = join(import.meta.dir, '..', 'assets', 'icons');
const SIZE = 64;

for (const file of readdirSync(DIR).filter((name) => name.endsWith('.svg'))) {
  const id = file.replace(/\.svg$/, '');
  const color = brand[id] ?? '#ffffff';
  const svg = readFileSync(join(DIR, file), 'utf8').replaceAll('currentColor', color);
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: SIZE }, background: 'rgba(0,0,0,0)' }).render().asPng();

  writeFileSync(join(DIR, `${id}.png`), png);
  console.log(`${id}.png  ${SIZE}px  ${color}`);
}
