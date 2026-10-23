import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'build', 'icon-source.png'));
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const images = await Promise.all(sizes.map((size) => sharp(source).resize(size, size).ensureAlpha().png().toBuffer()));

// Windows selects the closest image for each display scale. Keep the master,
// renderer PNG and executable ICO derived from the same source of truth.
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  header[entry] = sizes[index] === 256 ? 0 : sizes[index];
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
});
const ico = Buffer.concat([header, ...images]);
const png = await sharp(source).resize(512, 512).png().toBuffer();
await fs.mkdir(path.join(root, 'build'), { recursive: true });
await Promise.all([
  fs.writeFile(path.join(root, 'build', 'icon.ico'), ico),
  fs.writeFile(path.join(root, 'build', 'icon.png'), png),
  fs.writeFile(path.join(root, 'public', 'icon.ico'), ico),
  fs.writeFile(path.join(root, 'public', 'icon.png'), png),
]);
console.log(`Desktop icons generated from build/icon-source.png: ${sizes.join(', ')} px + 512 px PNG`);
