// Renders media/logo.svg to media/logo.png at 128x128 using @resvg/resvg-js.
// Usage: node scripts/render-logo.mjs [size]
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const size = Number(process.argv[2]) || 128;

const svgPath = path.join(root, 'media', 'logo.svg');
const pngPath = path.join(root, 'media', `logo${size === 128 ? '' : `-${size}`}.png`);

const svg = fs.readFileSync(svgPath);

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: size },
  background: 'rgba(0,0,0,0)',
  font: { loadSystemFonts: false },
});

const pngBuf = resvg.render().asPng();
fs.writeFileSync(pngPath, pngBuf);

console.log(`wrote ${pngPath} (${pngBuf.length} bytes, ${size}x${size})`);
