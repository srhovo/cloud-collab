const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const ZIP_VERSION = 20;
const MAX_ZIP_ENTRIES = 1024;

export class ZipStoreError extends Error {
  constructor(code, message, status = 500, details = null) {
    super(message || code || 'ZIP生成失败');
    this.name = 'ZipStoreError';
    this.code = code || 'ZIP_STORE_ERROR';
    this.status = status;
    this.details = details;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeEntryName(value) {
  const name = String(value || '').replace(/\\/g, '/');
  const bytes = Buffer.byteLength(name, 'utf8');
  if (!name || bytes > 0xffff || name.startsWith('/') || name.includes('../')
      || name.includes('/./') || name.endsWith('/.') || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ZipStoreError('ZIP_ENTRY_NAME_INVALID', 'ZIP文件名无效', 500, { name });
  }
  return name;
}

function normalizeDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ZipStoreError('ZIP_TIME_INVALID', 'ZIP时间无效');
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = Math.floor(date.getUTCSeconds() / 2);
  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
    dosTime: (hour << 11) | (minute << 5) | second,
  };
}

function uint16(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new ZipStoreError('ZIP_16BIT_LIMIT_EXCEEDED', `${label}超过ZIP限制`);
  }
  return value;
}

function uint32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ZipStoreError('ZIP_32BIT_LIMIT_EXCEEDED', `${label}超过ZIP32限制`);
  }
  return value;
}

export function createStoredZip(entries, {
  createdAt = Date.now(),
  maxBytes = 10 * 1024 * 1024,
  maxEntries = MAX_ZIP_ENTRIES,
} = {}) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > maxEntries) {
    throw new ZipStoreError('ZIP_ENTRY_COUNT_INVALID', 'ZIP文件数量无效', 413, {
      count: Array.isArray(entries) ? entries.length : null,
      maxEntries,
    });
  }
  const normalized = entries.map(entry => {
    const name = normalizeEntryName(entry?.name);
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entry?.data) ? Buffer.from(entry.data) : Buffer.from(entry?.data ?? '');
    return Object.freeze({ name, nameBytes, data, crc: crc32(data) });
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(normalized.map(entry => entry.name)).size !== normalized.length) {
    throw new ZipStoreError('ZIP_ENTRY_DUPLICATE', 'ZIP包含重复文件名');
  }

  const { dosDate, dosTime } = normalizeDate(createdAt);
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of normalized) {
    uint16(entry.nameBytes.length, 'ZIP文件名长度');
    uint32(entry.data.length, 'ZIP文件大小');
    uint32(localOffset, 'ZIP本地头偏移');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(STORE_METHOD, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, entry.nameBytes, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(STORE_METHOD, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, entry.nameBytes);

    localOffset += local.length + entry.nameBytes.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(uint16(normalized.length, 'ZIP文件数量'), 8);
  end.writeUInt16LE(uint16(normalized.length, 'ZIP文件数量'), 10);
  end.writeUInt32LE(uint32(centralBuffer.length, 'ZIP中央目录大小'), 12);
  end.writeUInt32LE(uint32(localOffset, 'ZIP中央目录偏移'), 16);
  end.writeUInt16LE(0, 20);

  const output = Buffer.concat([...localParts, centralBuffer, end]);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || output.length > maxBytes) {
    throw new ZipStoreError('ZIP_SIZE_LIMIT_EXCEEDED', '导出ZIP超过大小上限', 413, {
      byteLength: output.length,
      maxBytes,
    });
  }
  return Object.freeze({
    bytes: output,
    byteLength: output.length,
    entryCount: normalized.length,
    entries: Object.freeze(normalized.map(entry => Object.freeze({
      name: entry.name,
      byteLength: entry.data.length,
      crc32: entry.crc.toString(16).padStart(8, '0'),
    }))),
  });
}
