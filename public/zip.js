// Minimal ZIP writer (STORE method): media files are already compressed, so deflate would gain nothing.
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function header(size, fields) {
  const view = new DataView(new ArrayBuffer(size));
  let offset = 0;
  for (const [bytes, value] of fields) {
    if (bytes === 4) view.setUint32(offset, value, true);
    else view.setUint16(offset, value, true);
    offset += bytes;
  }
  return new Uint8Array(view.buffer);
}

/** @param {{ name: string, data: Uint8Array }[]} files */
export function createZip(files, date = new Date()) {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(date);
  const UTF8_FLAG = 0x0800;
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const common = [[2, 20], [2, UTF8_FLAG], [2, 0], [2, time], [2, day], [4, crc], [4, data.length], [4, data.length], [2, nameBytes.length], [2, 0]];

    const local = header(30, [[4, 0x04034b50], ...common]);
    parts.push(local, nameBytes, data);

    central.push(header(46, [[4, 0x02014b50], [2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]), nameBytes);
    offset += local.length + nameBytes.length + data.length;
    if (offset > 0xffffffff) throw new Error("ZIP is larger than 4 GB.");
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = header(22, [[4, 0x06054b50], [2, 0], [2, 0], [2, files.length], [2, files.length], [4, centralSize], [4, offset], [2, 0]]);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
