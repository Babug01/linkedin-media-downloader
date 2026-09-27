import assert from "node:assert/strict";
import { test } from "node:test";
import { createZip } from "../public/zip.js";

test("writes a valid STORE zip with correct CRCs, sizes, and offsets", async () => {
  const encoder = new TextEncoder();
  const files = [
    { name: "a.txt", data: encoder.encode("hello") },
    { name: "folder/b.bin", data: new Uint8Array([0, 1, 2, 255]) },
  ];
  const bytes = new Uint8Array(await createZip(files, new Date(2026, 8, 28, 12, 30, 10)).arrayBuffer());
  const view = new DataView(bytes.buffer);

  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  assert.equal(view.getUint16(eocd + 10, true), 2);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  assert.equal(centralOffset + centralSize, eocd);

  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(14, true), 0x3610a686, "crc32('hello')");
  assert.equal(view.getUint32(18, true), 5);
  assert.equal(new TextDecoder().decode(bytes.slice(30, 35)), "a.txt");
  assert.equal(new TextDecoder().decode(bytes.slice(35, 40)), "hello");

  const secondCentral = centralOffset + 46 + 5;
  assert.equal(view.getUint32(secondCentral, true), 0x02014b50);
  assert.equal(view.getUint32(secondCentral + 42, true), 40, "second local header offset");
  assert.equal(view.getUint32(40, true), 0x04034b50);
});
