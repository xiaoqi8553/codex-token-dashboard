const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const size = 256;
const pixels = Buffer.alloc((size * 4 + 1) * size);
function roundedRect(x, y, width, height, radius, color) {
  for (let py = Math.max(0, y); py < Math.min(size, y + height); py += 1) {
    for (let px = Math.max(0, x); px < Math.min(size, x + width); px += 1) {
      const dx = px < x + radius ? x + radius - px : px >= x + width - radius ? px - (x + width - radius - 1) : 0;
      const dy = py < y + radius ? y + radius - py : py >= y + height - radius ? py - (y + height - radius - 1) : 0;
      if (dx && dy && dx * dx + dy * dy > radius * radius) continue;
      const offset = py * (size * 4 + 1) + 1 + px * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
}
function setPixel(x, y, color) {
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = color[3];
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crcData = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of crcData) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}

for (let y = 0; y < size; y += 1) pixels[y * (size * 4 + 1)] = 0;
roundedRect(1, 1, 254, 254, 60, [23, 34, 53, 255]);
roundedRect(52, 132, 36, 72, 11, [54, 176, 149, 255]);
roundedRect(108, 96, 36, 108, 11, [239, 92, 105, 255]);
roundedRect(164, 60, 36, 144, 11, [86, 145, 250, 255]);
roundedRect(48, 212, 160, 12, 4, [205, 216, 231, 255]);
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(pixels)),
  chunk("IEND", Buffer.alloc(0))
]);
const outputPath = path.join(__dirname, "icon.png");
fs.writeFileSync(outputPath, png);
process.stdout.write(`${outputPath}\n`);
