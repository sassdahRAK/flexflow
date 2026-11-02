// Minimal dependency-free ZIP writer for tests.
// Produces stored (method 0) archives that FlexFlow.html's readZipBuffer can read.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function toBytes(input) {
    if (input instanceof Uint8Array) return Buffer.from(input);
    if (typeof input === 'string') return Buffer.from(input, 'utf8');
    return Buffer.from(input || []);
}

/**
 * @param {Array<{name: string, bytes: Uint8Array|string}>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const entry of entries || []) {
        const name = toBytes(entry.name);
        const data = toBytes(entry.bytes);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOCAL_SIG, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(0, 14); // crc32 (not checked by the app)
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(CENTRAL_SIG, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(0, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);

        offset += local.length + name.length + data.length;
    }

    const centralBytes = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBytes.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, centralBytes, eocd]);
}

/** Returns a fresh ArrayBuffer copy (readZipBuffer wraps it in a DataView). */
export function zipArrayBuffer(entries) {
    const buf = buildZip(entries);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
