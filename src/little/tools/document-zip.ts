import { inflateRawSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { LittleError } from '../shared/errors';
import { assertNotAborted } from './workspace-service';
import { DOCUMENT_LIMITS, documentFailure } from './document-common';

interface ZipEntry { name: string; method: number; compressed: number; size: number; crc: number; offset: number; flags: number }
const crcTable = Uint32Array.from({ length: 256 }, (_, number) => {
  let crc = number;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Uint8Array) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function sizeFailure(): never { throw new LittleError('CONTEXT_LIMIT', 'The document package exceeds the bounded archive inspection size.'); }
function entryName(bytes: Uint8Array): string {
  let name: string;
  try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { documentFailure(); }
  if (!name || name.length > 512 || /[\u0000-\u001f\\:]/.test(name) || name.startsWith('/') ||
    name.split('/').some((part, index, all) => part === '.' || part === '..' || (!part && index !== all.length - 1))) documentFailure();
  return name;
}

/** Read ZIP directory metadata before inflating any entry. No package path is written to disk. */
export class DocumentArchive {
  private readonly data: Buffer;
  private readonly entries = new Map<string, ZipEntry>();
  private readonly cache = new Map<string, Uint8Array>();
  private expanded = 0;
  constructor(input: Uint8Array, private readonly signal?: AbortSignal) {
    assertNotAborted(signal);
    if (input.length > DOCUMENT_LIMITS.maxFileBytes) sizeFailure();
    this.data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const data = this.data;
    if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) documentFailure('Only unencrypted OOXML ZIP documents are supported. Legacy or encrypted Office containers cannot be read.');
    let end = data.length - 22;
    while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < Math.max(0, data.length - 65557) || end + 22 + data.readUInt16LE(end + 20) !== data.length) documentFailure();
    const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16);
    if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== count || count === 0xffff || start === 0xffffffff || size === 0xffffffff) documentFailure('Multi-volume and ZIP64 Office packages are unsupported.');
    if (count > DOCUMENT_LIMITS.maxEntries) sizeFailure();
    if (start + size !== end) documentFailure();
    let cursor = start, declared = 0;
    for (let index = 0; index < count; index++) {
      assertNotAborted(signal);
      if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) documentFailure();
      const flags = data.readUInt16LE(cursor + 8), method = data.readUInt16LE(cursor + 10);
      const compressed = data.readUInt32LE(cursor + 20), entrySize = data.readUInt32LE(cursor + 24);
      const nameSize = data.readUInt16LE(cursor + 28), extraSize = data.readUInt16LE(cursor + 30), commentSize = data.readUInt16LE(cursor + 32);
      if (cursor + 46 + nameSize + extraSize + commentSize > end) documentFailure();
      const name = entryName(data.subarray(cursor + 46, cursor + 46 + nameSize));
      if (flags & 1 || flags & 0x40 || ![0, 8].includes(method) || data.readUInt16LE(cursor + 34) ||
        ((data.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000) documentFailure();
      if (compressed > DOCUMENT_LIMITS.maxFileBytes || entrySize > DOCUMENT_LIMITS.maxExpandedBytes || (declared += entrySize) > DOCUMENT_LIMITS.maxExpandedBytes) sizeFailure();
      const offset = data.readUInt32LE(cursor + 42);
      if (offset + 30 > start || data.readUInt32LE(offset) !== 0x04034b50 ||
        data.readUInt16LE(offset + 6) !== flags || data.readUInt16LE(offset + 8) !== method) documentFailure();
      const localNameSize = data.readUInt16LE(offset + 26), localExtraSize = data.readUInt16LE(offset + 28);
      const payload = offset + 30 + localNameSize + localExtraSize;
      if (payload + compressed > start || entryName(data.subarray(offset + 30, offset + 30 + localNameSize)) !== name) documentFailure();
      if (!(flags & 8) && (data.readUInt32LE(offset + 18) !== compressed || data.readUInt32LE(offset + 22) !== entrySize)) documentFailure();
      if (this.entries.has(name)) documentFailure();
      this.entries.set(name, { name, method, compressed, size: entrySize, crc: data.readUInt32LE(cursor + 16), offset: payload, flags });
      cursor += 46 + nameSize + extraSize + commentSize;
    }
    if (cursor !== end || [...this.entries.keys()].some(name => /(?:vbaProject\.bin|activex\/)/i.test(name))) documentFailure('Macro and ActiveX document packages are unsupported.');
  }
  names(): string[] { return [...this.entries.keys()]; }
  has(name: string) { return this.entries.has(name); }
  read(name: string, limit: number = DOCUMENT_LIMITS.maxExpandedBytes): Uint8Array {
    assertNotAborted(this.signal);
    const entry = this.entries.get(name);
    if (!entry) documentFailure('A required document package part is missing.');
    if (entry.size > limit) sizeFailure();
    const cached = this.cache.get(name);
    if (cached) return cached;
    let result: Uint8Array;
    try {
      const input = this.data.subarray(entry.offset, entry.offset + entry.compressed);
      result = entry.method === 0 ? Uint8Array.from(input) : inflateRawSync(input, { maxOutputLength: Math.max(1, Math.min(limit, DOCUMENT_LIMITS.maxExpandedBytes - this.expanded)) });
    } catch { documentFailure('The document archive is corrupt or exceeds its bounded expansion size.'); }
    if (result.length !== entry.size || crc32(result) !== entry.crc) documentFailure('The document archive checksum or declared size is invalid.');
    this.expanded += result.length;
    if (this.expanded > DOCUMENT_LIMITS.maxExpandedBytes) sizeFailure();
    assertNotAborted(this.signal);
    this.cache.set(name, result);
    return result;
  }
  xml(name: string): string {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(this.read(name, DOCUMENT_LIMITS.maxXmlBytes)); }
    catch (error) { if (error instanceof LittleError) throw error; documentFailure(); }
    return text;
  }
  preserve(): Record<string, Uint8Array> {
    const result: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
    for (const name of this.names()) result[name] = this.read(name);
    return result;
  }
}
export function documentZip(parts: Record<string, Uint8Array | string>): Uint8Array {
  const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  let size = 0;
  if (Object.keys(parts).length > DOCUMENT_LIMITS.maxEntries) sizeFailure();
  for (const [name, content] of Object.entries(parts)) {
    entryName(Buffer.from(name));
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if ((size += bytes.length) > DOCUMENT_LIMITS.maxExpandedBytes) sizeFailure();
    files[name] = bytes;
  }
  const result = zipSync(files, { level: 6 });
  if (result.length > DOCUMENT_LIMITS.maxFileBytes) sizeFailure();
  return result;
}
