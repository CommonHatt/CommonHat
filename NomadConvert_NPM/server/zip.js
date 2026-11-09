// Minimal streaming ZIP writer (STORE, no external dependencies).
// Files may contain up to 800 MB total; ZIP64 is intentionally unnecessary.
import fs from 'node:fs';
import {open, stat} from 'node:fs/promises';
import {once} from 'node:events';

const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[i] = c >>> 0;
}
function crcUpdate(crc, bytes) {
  for (const b of bytes) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
async function checksum(path) {
  let crc = 0xffffffff;
  for await (const chunk of fs.createReadStream(path)) crc = crcUpdate(crc, chunk);
  return (crc ^ 0xffffffff) >>> 0;
}
async function write(stream, buffer) {
  if (!stream.write(buffer)) await once(stream, 'drain');
}
function localHeader(name, size, crc) {
  const nameBuf = Buffer.from(name, 'utf8');
  const b = Buffer.alloc(30 + nameBuf.length);
  b.writeUInt32LE(0x04034b50, 0); b.writeUInt16LE(20, 4); b.writeUInt16LE(0x800, 6);
  b.writeUInt16LE(0, 8); b.writeUInt32LE(crc, 14); b.writeUInt32LE(size, 18);
  b.writeUInt32LE(size, 22); b.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(b, 30);
  return b;
}
function centralHeader(name, size, crc, offset) {
  const nameBuf = Buffer.from(name, 'utf8');
  const b = Buffer.alloc(46 + nameBuf.length);
  b.writeUInt32LE(0x02014b50, 0); b.writeUInt16LE(20, 4); b.writeUInt16LE(20, 6);
  b.writeUInt16LE(0x800, 8); b.writeUInt16LE(0, 10); b.writeUInt32LE(crc, 16);
  b.writeUInt32LE(size, 20); b.writeUInt32LE(size, 24); b.writeUInt16LE(nameBuf.length, 28);
  b.writeUInt32LE(offset, 42); nameBuf.copy(b, 46); return b;
}
function cleanArchiveName(s) {
  let name = String(s || 'file').replaceAll('\\', '/').split('/').pop().replace(/[\x00-\x1f]/g, '').slice(0, 180);
  if (!name || name === '.' || name === '..') name = 'file';
  return name;
}
export async function zipFiles(files, destination) {
  if (!files.length || files.length > 60) throw new Error('В ZIP можно добавить от 1 до 60 файлов');
  const stream = fs.createWriteStream(destination, {flags:'wx'});
  const used = new Set();
  const centers = [];
  let offset = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const src = files[i];
      const stats = await stat(src.path);
      if (stats.size > 0xffffffff) throw new Error('Размер файла превышает ограничение ZIP');
      let name = cleanArchiveName(src.name), duplicate = 1;
      while (used.has(name)) name = `${++duplicate}_${cleanArchiveName(src.name)}`;
      used.add(name);
      const crc = await checksum(src.path);
      const header = localHeader(name, stats.size, crc);
      await write(stream, header);
      for await (const chunk of fs.createReadStream(src.path)) await write(stream, chunk);
      centers.push(centralHeader(name, stats.size, crc, offset));
      offset += header.length + stats.size;
    }
    const centralOffset = offset;
    for (const c of centers) {await write(stream, c); offset += c.length;}
    const trailer = Buffer.alloc(22);
    trailer.writeUInt32LE(0x06054b50, 0);
    trailer.writeUInt16LE(centers.length, 8); trailer.writeUInt16LE(centers.length, 10);
    trailer.writeUInt32LE(offset - centralOffset, 12);
    trailer.writeUInt32LE(centralOffset, 16);
    await write(stream, trailer);
    stream.end();
    await once(stream, 'finish');
  } catch (error) {
    stream.destroy();
    throw error;
  }
}
