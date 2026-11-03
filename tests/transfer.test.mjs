// Hermetic unit tests for the peer-transfer pure API in FlexFlow.html.
// Run with: node --test tests/transfer.test.mjs
//
// The app script is loaded into a node:vm context with DOM/localStorage stubs,
// so these exercise the real source without a browser or network. Storage is
// in-memory only; nothing here writes to disk or the network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadApp } from './lib/load-app.mjs';
import { zipArrayBuffer } from './lib/zip.mjs';

const { api, storage } = loadApp();

const NOW = '2026-05-01T00:00:00.000Z';
const utf8 = value => new TextEncoder().encode(value);
const clone = value => JSON.parse(JSON.stringify(value));
const HEX8 = /^[0-9a-f]{8}$/;

function blankArtists() {
    return { version: 1, artists: [], slots: [], events: [] };
}

/** Replaces in-memory storage with the supplied collections. */
function seed(data = {}) {
    const keys = api.STORAGE_KEYS;
    storage.clear();
    if (data.tasks !== undefined) storage.setItem(keys.tasks, JSON.stringify(data.tasks));
    if (data.notes !== undefined) storage.setItem(keys.notes, JSON.stringify(data.notes));
    if (data.changeLog !== undefined) storage.setItem(keys.changeLog, JSON.stringify(data.changeLog));
    if (data.artists !== undefined) storage.setItem(keys.artists, JSON.stringify(data.artists));
}

function storageSnapshot() {
    const out = {};
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        out[key] = storage.getItem(key);
    }
    return out;
}

/** Reads a zip and rebuilds a name -> Uint8Array map the way the app does. */
function entriesFromZip(zipBytes) {
    const parsed = api.readZipBuffer(zipBytes);
    assert.equal(parsed.ok, true, parsed.message);
    const map = Object.create(null);
    parsed.entries.forEach(entry => api.putBackupEntry(map, entry.name, entry.bytes));
    return map;
}

function sampleLocal() {
    return {
        tasks: [
            {
                id: 'card-1',
                title: 'Gig',
                checklist: [{ id: 'i-1', text: 'a' }, { id: 'i-2', text: 'b' }]
            }
        ],
        quickNotes: [
            { id: 'qn-1', type: 'text', text: 'hello' },
            { id: 'qn-video', type: 'video' },
            { id: 'qn-media', type: 'text', text: 'clip', mediaId: 'm-1' },
            { id: 'qn-image', type: 'image', imageUrl: 'https://example.com/x.png' }
        ],
        artists: { version: 1, artists: [{ id: 'ar-1', name: 'A' }], slots: [], events: [] },
        changeLog: [{ op: 'card.update', cardId: 'card-1' }]
    };
}

function buildBackupPayload() {
    // Same shape buildBackupPayload() returns: version + exportedAt + tasks + quickNotes.
    return {
        version: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        tasks: [{ id: 'card-1', title: 'Task', checklist: [], detailPoints: [] }],
        quickNotes: [{
            id: 'qn-1',
            type: 'image',
            text: '',
            imageUrl: { file: 'images/qn-1.jpg' },
            createdAt: '2026-01-01T00:00:00.000Z'
        }]
    };
}

// ---------------------------------------------------------------------------
// Scope metadata
// ---------------------------------------------------------------------------

test('TRANSFER_SCOPES exposes the three contract scopes in order', () => {
    const scopes = api.TRANSFER_SCOPES;
    assert.equal(Array.isArray(scopes), true);
    assert.equal(scopes.length, 3);
    assert.deepEqual(clone(scopes.map(s => s.id)), ['all', 'media', 'metadata']);
    for (const scope of scopes) {
        assert.equal(typeof scope.label, 'string');
        assert.ok(scope.label.length > 0, scope.id + ' must have a label');
        assert.equal(typeof scope.desc, 'string');
        assert.ok(scope.desc.length > 0, scope.id + ' must have a description');
    }
});

test('PEER_BACKUP_KEY matches the documented localStorage record key', () => {
    assert.equal(api.PEER_BACKUP_KEY, 'cambodia_peer_backup_v1');
});

test('isTransferScope accepts only all/media/metadata', () => {
    for (const id of ['all', 'media', 'metadata']) {
        assert.equal(api.isTransferScope(id), true, id + ' must be a transfer scope');
    }
    for (const bad of ['', 'ALL', 'Media', 'everything', null, undefined, 0, {}, [], ['all']]) {
        assert.equal(api.isTransferScope(bad), false, JSON.stringify(bad) + ' must not be a transfer scope');
    }
});

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

test('transferChecksum is 8 lowercase hex chars, deterministic and sensitive', () => {
    const digest = api.transferChecksum('hello');
    assert.match(digest, HEX8);
    assert.equal(digest, api.transferChecksum('hello'));
    assert.notEqual(digest, api.transferChecksum('hellp'));
    assert.notEqual(api.transferChecksum('a'), api.transferChecksum('b'));
});

test('transferChecksum handles empty and non-string input via string coercion', () => {
    for (const value of ['', null, undefined]) {
        assert.match(api.transferChecksum(value), HEX8);
    }
    assert.equal(api.transferChecksum(null), api.transferChecksum(''));
    assert.equal(api.transferChecksum(undefined), api.transferChecksum(''));
    assert.equal(api.transferChecksum(42), api.transferChecksum('42'));
    assert.notEqual(api.transferChecksum(''), api.transferChecksum('x'));
});

test('transferByteChecksum is deterministic across Uint8Array, ArrayBuffer and plain arrays', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const plain = [0, 1, 2, 250, 255];

    const digest = api.transferByteChecksum(bytes);
    assert.match(digest, HEX8);
    assert.equal(api.transferByteChecksum(arrayBuffer), digest);
    assert.equal(api.transferByteChecksum(plain), digest);
    assert.equal(api.transferByteChecksum(Uint8Array.from([0, 1, 2, 250, 255])), digest);
});

test('transferByteChecksum is stable for empty input and changes when one byte changes', () => {
    const empty = api.transferByteChecksum(new Uint8Array(0));
    assert.match(empty, HEX8);
    assert.equal(api.transferByteChecksum(new ArrayBuffer(0)), empty);
    assert.equal(api.transferByteChecksum([]), empty);

    const original = Uint8Array.from([0, 1, 2, 250, 255]);
    const changed = Uint8Array.from([0, 1, 2, 250, 254]);
    assert.notEqual(api.transferByteChecksum(original), api.transferByteChecksum(changed));
});

// ---------------------------------------------------------------------------
// Scope summaries
// ---------------------------------------------------------------------------

test('transferScopeSummary counts the seeded collections per scope', () => {
    const tasks = [
        { id: 'card-1', title: 'One', checklist: [{ id: 'i-1', text: 'a' }, { id: 'i-2', text: 'b' }] },
        { id: 'card-2', title: 'Two', checklist: [{ id: 'i-3', text: 'c' }] }
    ];
    const notes = [
        { id: 'qn-1', type: 'text', text: 'plain' },
        { id: 'qn-2', type: 'image', imageUrl: 'https://example.com/a.png' },
        { id: 'qn-3', type: 'video' },
        { id: 'qn-4', type: 'text', text: 'clip', mediaId: 'm-1' },
        { id: 'qn-5', type: 'location', lat: 11.5, lng: 104.9 }
    ];
    const artists = {
        version: 1,
        artists: [{ id: 'ar-1', name: 'A' }, { id: 'ar-2', name: 'B' }],
        slots: [],
        events: []
    };
    const changeLog = [{ op: 'card.update' }, { op: 'item.status' }, { op: 'note.create' }];
    seed({ tasks, notes, changeLog, artists });

    const all = api.transferScopeSummary('all');
    assert.equal(all.scope, 'all');
    assert.equal(all.label, api.TRANSFER_SCOPES[0].label);
    assert.equal(all.desc, api.TRANSFER_SCOPES[0].desc);
    assert.deepEqual(clone(all.counts), { cards: 2, items: 3, notes: 5, media: 4, artists: 2, changes: 3, videos: 2 });
    assert.equal(all.empty, false);
    assert.ok(all.bytes > 0, 'a populated summary must report bytes');

    const media = api.transferScopeSummary('media');
    assert.equal(media.scope, 'media');
    assert.equal(media.label, api.TRANSFER_SCOPES[1].label);
    assert.deepEqual(clone(media.counts), { cards: 0, items: 0, notes: 5, media: 4, artists: 0, changes: 0, videos: 2 });
    assert.equal(media.empty, false);
    assert.ok(media.bytes > 0);

    const metadata = api.transferScopeSummary('metadata');
    assert.equal(metadata.scope, 'metadata');
    assert.equal(metadata.label, api.TRANSFER_SCOPES[2].label);
    assert.deepEqual(clone(metadata.counts), { cards: 0, items: 0, notes: 0, media: 0, artists: 2, changes: 3, videos: 0 });
    assert.equal(metadata.empty, false);
    assert.ok(metadata.bytes > 0);
});

test('transferScopeSummary marks every scope empty with no stored data', () => {
    storage.clear();
    for (const id of ['all', 'media', 'metadata']) {
        const summary = api.transferScopeSummary(id);
        assert.equal(summary.scope, id);
        assert.equal(summary.empty, true, id + ' must be empty with no data');
        assert.equal(typeof summary.bytes, 'number');
        assert.ok(summary.bytes >= 0 && summary.bytes <= 1024, id + ' empty payload bytes should be tiny');
        const meta = api.TRANSFER_SCOPES.find(s => s.id === id);
        assert.equal(summary.label, meta.label);
        assert.equal(summary.desc, meta.desc);
    }
});

// ---------------------------------------------------------------------------
// Envelope building
// ---------------------------------------------------------------------------

test('buildTransferEnvelope emits a well-typed kind/version/scope/sender/checksum', () => {
    const envelope = api.buildTransferEnvelope('all', { local: sampleLocal(), now: NOW });
    assert.equal(envelope.kind, 'flexflow-transfer');
    assert.equal(envelope.version, 1);
    assert.equal(envelope.scope, 'all');
    assert.equal(envelope.createdAt, NOW);
    assert.equal(typeof envelope.sender.name, 'string');
    assert.ok(envelope.sender.name.length > 0);
    assert.equal(typeof envelope.sender.platform, 'string');
    assert.ok(envelope.sender.platform.length > 0);
    assert.equal(typeof envelope.data, 'object');
    assert.equal(typeof envelope.summary, 'object');
    assert.match(envelope.checksum, HEX8);
});

test('buildTransferEnvelope scopes the payload (all/media/metadata) and signs it', () => {
    const local = sampleLocal();

    const all = api.buildTransferEnvelope('all', { local, now: NOW });
    assert.ok(Array.isArray(all.data.tasks));
    assert.equal(all.data.tasks.length, 1);
    assert.equal(all.data.quickNotes.length, 2, 'video notes must not be in the payload');
    assert.ok(Array.isArray(all.data.artists.artists));
    assert.equal(all.data.artists.artists.length, 1);
    assert.equal(all.data.changeLog.length, 1);
    assert.equal(typeof all.data.meta, 'object');
    assert.equal(all.summary.counts.videos, 2);
    assert.equal(all.checksum, api.transferChecksum(JSON.stringify([all.version, all.scope, all.data])));

    const media = api.buildTransferEnvelope('media', { local, now: NOW });
    assert.deepEqual(Object.keys(media.data), ['quickNotes']);
    assert.equal(media.data.quickNotes.length, 2);
    assert.equal(media.summary.counts.cards, 0);
    assert.equal(media.checksum, api.transferChecksum(JSON.stringify([media.version, media.scope, media.data])));

    const metadata = api.buildTransferEnvelope('metadata', { local, now: NOW });
    assert.equal(metadata.data.tasks, undefined);
    assert.equal(metadata.data.quickNotes, undefined);
    assert.ok(Array.isArray(metadata.data.artists.artists));
    assert.ok(Array.isArray(metadata.data.changeLog));
    assert.equal(typeof metadata.data.meta, 'object');
    assert.equal(metadata.summary.counts.notes, 0);
    assert.equal(metadata.checksum, api.transferChecksum(JSON.stringify([metadata.version, metadata.scope, metadata.data])));
});

test('video notes are excluded and counted, including mediaId-only notes', () => {
    const local = {
        tasks: [],
        quickNotes: [
            { id: 'qn-keep', type: 'text', text: 'keep me' },
            { id: 'qn-video', type: 'video', text: 'clip' },
            { id: 'qn-media', type: 'text', text: 'clip', mediaId: 'm-1' }
        ],
        artists: blankArtists(),
        changeLog: []
    };
    const envelope = api.buildTransferEnvelope('all', { local, now: NOW });
    assert.deepEqual(envelope.data.quickNotes.map(n => n.id), ['qn-keep']);
    assert.equal(envelope.summary.counts.videos, 2);
    assert.equal(envelope.summary.counts.notes, 3);

    const media = api.buildTransferEnvelope('media', { local, now: NOW });
    assert.deepEqual(media.data.quickNotes.map(n => n.id), ['qn-keep']);
    assert.equal(media.summary.counts.videos, 2);
});

test('buildTransferEnvelope throws for every invalid transfer scope', () => {
    const local = sampleLocal();
    assert.throws(() => api.buildTransferEnvelope('bogus', { local, now: NOW }), /Unknown transfer scope/);
    assert.throws(() => api.buildTransferEnvelope('', { local, now: NOW }), /Unknown transfer scope/);
    assert.throws(() => api.buildTransferEnvelope(null, { local, now: NOW }), /Unknown transfer scope/);
    assert.throws(() => api.buildTransferEnvelope('ALL', { local, now: NOW }), /Unknown transfer scope/);
    assert.throws(() => api.buildTransferEnvelope({ scope: 'all' }, { local, now: NOW }), /Unknown transfer scope/);
});

test('an invalid scope fails closed before any payload can be built', () => {
    const local = sampleLocal();
    let thrown = null;
    try {
        api.buildTransferEnvelope('bogus', { local, now: NOW });
    } catch (error) {
        thrown = error;
    }
    assert.ok(thrown, 'an invalid scope must throw, never return an envelope');
    assert.equal(thrown.name, 'TypeError');
    assert.match(thrown.message, /Unknown transfer scope/);
    assert.ok(thrown.message.includes('bogus'), 'the error should name the offending scope');
    // Privacy guarantee: no payload may leak just because the scope was wrong.
    assert.equal(Object.prototype.hasOwnProperty.call(thrown, 'data'), false);
    assert.equal(thrown.envelope, undefined);
});

test('buildTransferEnvelope still builds the three valid scopes exactly as before', () => {
    const local = sampleLocal();
    for (const scope of ['all', 'media', 'metadata']) {
        const envelope = api.buildTransferEnvelope(scope, { local, now: NOW });
        assert.equal(envelope.scope, scope);
        assert.equal(envelope.kind, 'flexflow-transfer');
        assert.equal(envelope.version, 1);
        assert.equal(envelope.checksum, api.transferChecksum(JSON.stringify([envelope.version, envelope.scope, envelope.data])));
    }
});

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

test('validateTransferEnvelope accepts a freshly built envelope', () => {
    const envelope = api.buildTransferEnvelope('media', { local: sampleLocal(), now: NOW });
    const result = api.validateTransferEnvelope(envelope);
    assert.equal(result.ok, true);
    assert.equal(result.envelope, envelope);
});

test('validateTransferEnvelope rejects non-objects, wrong kind, version, scope and missing data', () => {
    const base = api.buildTransferEnvelope('all', { local: sampleLocal(), now: NOW });
    const cases = [];
    cases.push(['null', null]);
    cases.push(['array', []]);
    cases.push(['string', 'flexflow-transfer']);

    const wrongKind = clone(base); wrongKind.kind = 'something-else';
    cases.push(['wrong kind', wrongKind]);

    const wrongVersion = clone(base); wrongVersion.version = 2;
    cases.push(['wrong version', wrongVersion]);

    const unknownScope = clone(base); unknownScope.scope = 'everything';
    cases.push(['unknown scope', unknownScope]);

    const missingData = clone(base); delete missingData.data;
    cases.push(['missing data', missingData]);
    const arrayData = clone(base); arrayData.data = [];
    cases.push(['array data', arrayData]);

    for (const [label, value] of cases) {
        const result = api.validateTransferEnvelope(value);
        assert.equal(result.ok, false, label + ' must be rejected');
        assert.equal(typeof result.error, 'string', label + ' must return an error string');
        assert.ok(result.error.length > 0, label + ' error must not be empty');
    }
});

test('validateTransferEnvelope rejects an envelope whose scope was tampered to an unknown id', () => {
    const envelope = api.buildTransferEnvelope('all', { local: sampleLocal(), now: NOW });
    assert.equal(api.validateTransferEnvelope(envelope).ok, true);
    for (const badScope of ['everything', '', 'ALL', null]) {
        const tampered = clone(envelope);
        tampered.scope = badScope;
        const result = api.validateTransferEnvelope(tampered);
        assert.equal(result.ok, false, JSON.stringify(badScope) + ' must be rejected');
        assert.equal(typeof result.error, 'string');
        assert.ok(result.error.length > 0);
    }
});

test('validateTransferEnvelope rejects a payload tampered after signing', () => {
    const envelope = api.buildTransferEnvelope('all', { local: sampleLocal(), now: NOW });
    assert.equal(api.validateTransferEnvelope(envelope).ok, true);

    envelope.data.tasks[0].title = 'tampered title';
    const result = api.validateTransferEnvelope(envelope);
    assert.equal(result.ok, false);
    assert.match(result.error, /checksum/i);
});

test('validateTransferEnvelope rejects array payloads over 5000 cards and 20000 change entries', () => {
    const tooManyTasks = api.buildTransferEnvelope('all', { local: sampleLocal(), now: NOW });
    tooManyTasks.data.tasks = Array.from({ length: 5001 }, (_, i) => ({ id: 'card-' + i, checklist: [] }));
    const tasksResult = api.validateTransferEnvelope(tooManyTasks);
    assert.equal(tasksResult.ok, false);
    assert.match(tasksResult.error, /5000/);

    const tooManyChanges = api.buildTransferEnvelope('metadata', { local: sampleLocal(), now: NOW });
    tooManyChanges.data.changeLog = Array.from({ length: 20001 }, (_, i) => ({ op: 'card.update', seq: i }));
    const changesResult = api.validateTransferEnvelope(tooManyChanges);
    assert.equal(changesResult.ok, false);
    assert.match(changesResult.error, /20000/);
});

test('validateTransferEnvelope rejects payloads whose JSON exceeds 8 MB', () => {
    const envelope = api.buildTransferEnvelope('all', { local: sampleLocal(), now: NOW });
    envelope.data.huge = 'x'.repeat(8 * 1024 * 1024 + 16);
    const result = api.validateTransferEnvelope(envelope);
    assert.equal(result.ok, false);
    assert.match(result.error, /8 MB/);
});

// ---------------------------------------------------------------------------
// Entry classification (zip/json import classifier)
// ---------------------------------------------------------------------------

test('classifyTransferEntries recognises a valid transfer.json envelope', () => {
    const envelope = api.buildTransferEnvelope('media', { local: sampleLocal(), now: NOW });
    const map = Object.create(null);
    map['transfer.json'] = utf8(JSON.stringify(envelope));

    const result = api.classifyTransferEntries(map);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'envelope');
    assert.equal(result.envelope.scope, 'media');
    assert.equal(result.envelope.checksum, envelope.checksum);
});

test('classifyTransferEntries rejects invalid transfer.json JSON and bad checksums', () => {
    const invalidJson = Object.create(null);
    invalidJson['transfer.json'] = utf8('{not json');
    const jsonResult = api.classifyTransferEntries(invalidJson);
    assert.equal(jsonResult.ok, false);
    assert.equal(typeof jsonResult.error, 'string');
    assert.ok(jsonResult.error.length > 0);
    assert.notEqual(jsonResult.kind, 'envelope');

    const envelope = api.buildTransferEnvelope('media', { local: sampleLocal(), now: NOW });
    const tampered = clone(envelope);
    tampered.data.quickNotes[0].text = 'tampered after signing';
    const map = Object.create(null);
    map['transfer.json'] = utf8(JSON.stringify(tampered));
    const checksumResult = api.classifyTransferEntries(map);
    assert.equal(checksumResult.ok, false);
    assert.match(checksumResult.error, /checksum/i);
    assert.notEqual(checksumResult.kind, 'envelope');
});

test('classifyTransferEntries stages a buildBackupPayload-shaped backup.json as a full backup', () => {
    const map = Object.create(null);
    map['backup.json'] = utf8(JSON.stringify(buildBackupPayload()));
    map['images/qn-1.jpg'] = Uint8Array.from([1, 2, 3, 4]);

    const result = api.classifyTransferEntries(map);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'backup');
    assert.equal(result.staged.kind, 'full');
    assert.equal(result.staged.tasks.length, 1);
    assert.equal(result.staged.quickNotes.length, 1);
    assert.match(String(result.staged.quickNotes[0].imageUrl), /^data:/);
});

test('classifyTransferEntries treats a media.json-only archive as a media backup', () => {
    const map = Object.create(null);
    map['media.json'] = utf8(JSON.stringify({ notes: { 'qn-1': { type: 'text', text: 'hi' } } }));

    const result = api.classifyTransferEntries(map);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'backup');
    assert.equal(result.staged.kind, 'media');
});

test('classifyTransferEntries reports a helpful error for an empty archive', () => {
    const result = api.classifyTransferEntries({});
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.match(result.error, /backup\.json|media\.json|changes\.json/);
});

test('a backup zip round-trips through readZipBuffer into a staged full backup', () => {
    const zip = zipArrayBuffer([
        { name: 'backup.json', bytes: JSON.stringify(buildBackupPayload()) },
        { name: 'images/qn-1.jpg', bytes: Uint8Array.from([1, 2, 3, 4]) }
    ]);
    const result = api.classifyTransferEntries(entriesFromZip(zip));
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'backup');
    assert.equal(result.staged.kind, 'full');
    assert.equal(result.staged.tasks.length, 1);
});

test('a saved transfer.json envelope survives a zip round-trip with its checksum intact', () => {
    const envelope = api.buildTransferEnvelope('all', { local: sampleLocal(), now: NOW });
    const zip = zipArrayBuffer([
        { name: 'transfer.json', bytes: utf8(JSON.stringify(envelope)) }
    ]);

    const map = entriesFromZip(zip);
    const result = api.classifyTransferEntries(map);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'envelope');
    assert.equal(result.envelope.checksum, envelope.checksum);
});

// ---------------------------------------------------------------------------
// Apply planning
// ---------------------------------------------------------------------------

test('planTransferApply merge adds new records and lets the newest card/note/artist win', () => {
    const local = {
        tasks: [
            { id: 'card-existing', title: 'Local title', checklist: [], updatedAt: '2020-01-01T00:00:00.000Z' },
            { id: 'card-stale', title: 'Local stale', checklist: [], updatedAt: '2030-01-01T00:00:00.000Z' }
        ],
        quickNotes: [
            { id: 'qn-existing', type: 'text', text: 'Local note', createdAt: '2020-01-01T00:00:00.000Z' },
            { id: 'qn-stale', type: 'text', text: 'Local stale note', createdAt: '2030-01-01T00:00:00.000Z' }
        ],
        artists: {
            version: 1,
            artists: [{ id: 'ar-existing', name: 'Local artist', updatedAt: '2020-01-01T00:00:00.000Z' }],
            slots: [],
            events: []
        },
        changeLog: []
    };
    const incoming = {
        tasks: [
            { id: 'card-new', title: 'New card', checklist: [], updatedAt: '2022-01-01T00:00:00.000Z' },
            { id: 'card-existing', title: 'Remote newer', checklist: [], updatedAt: '2025-01-01T00:00:00.000Z' },
            { id: 'card-stale', title: 'Remote stale', checklist: [], updatedAt: '2020-01-01T00:00:00.000Z' }
        ],
        quickNotes: [
            { id: 'qn-new', type: 'text', text: 'New note', createdAt: '2022-01-01T00:00:00.000Z' },
            { id: 'qn-existing', type: 'text', text: 'Remote note', createdAt: '2025-01-01T00:00:00.000Z' },
            { id: 'qn-stale', type: 'text', text: 'Remote stale note', createdAt: '2020-01-01T00:00:00.000Z' }
        ],
        artists: {
            version: 1,
            artists: [
                { id: 'ar-existing', name: 'Remote artist', updatedAt: '2025-01-01T00:00:00.000Z' },
                { id: 'ar-new', name: 'New artist', updatedAt: '2022-01-01T00:00:00.000Z' }
            ],
            slots: [],
            events: []
        },
        changeLog: []
    };

    // Seed storage with a marker so we can prove planning never writes it.
    seed({
        tasks: [{ id: 'card-marker', title: 'Marker', checklist: [], updatedAt: '2000-01-01T00:00:00.000Z' }],
        notes: [], changeLog: [], artists: blankArtists()
    });
    const before = storageSnapshot();

    const envelope = api.buildTransferEnvelope('all', { local: incoming, now: NOW });
    const result = api.planTransferApply(envelope, 'merge', local);

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'merge');

    const tasksById = Object.fromEntries(result.tasks.map(t => [t.id, t]));
    assert.ok(tasksById['card-new'], 'a new incoming card must be added');
    assert.equal(tasksById['card-existing'].title, 'Remote newer', 'newer incoming card fields win');
    assert.equal(tasksById['card-stale'].title, 'Local stale', 'older incoming card fields are skipped');

    const notesById = Object.fromEntries(result.quickNotes.map(n => [n.id, n]));
    assert.ok(notesById['qn-new'], 'a new incoming note must be added');
    assert.equal(notesById['qn-existing'].text, 'Remote note', 'newer incoming note wins');
    assert.equal(notesById['qn-stale'].text, 'Local stale note', 'older incoming note is skipped');

    const artistsById = Object.fromEntries(result.artists.artists.map(a => [a.id, a]));
    assert.equal(artistsById['ar-existing'].name, 'Remote artist', 'newer incoming artist wins by id');
    assert.equal(artistsById['ar-new'].name, 'New artist', 'a new incoming artist is added');

    assert.deepEqual(storageSnapshot(), before, 'merge planning must not write localStorage');
});

test('planTransferApply replace returns only sanitized incoming data and ignores local', () => {
    seed({
        tasks: [{ id: 'card-marker', title: 'Marker', checklist: [], updatedAt: '2000-01-01T00:00:00.000Z' }],
        notes: [], changeLog: [], artists: blankArtists()
    });
    const before = storageSnapshot();
    const poisonLocal = {
        tasks: [{ id: 'card-poison', title: 'Poison', checklist: [], updatedAt: '2000-01-01T00:00:00.000Z' }],
        quickNotes: [{ id: 'qn-poison', type: 'text', text: 'Poison', createdAt: '2000-01-01T00:00:00.000Z' }],
        artists: { version: 1, artists: [{ id: 'ar-poison', name: 'Poison' }], slots: [], events: [] },
        changeLog: []
    };
    const incoming = {
        tasks: [{ id: 'card-in', title: 'Incoming', checklist: [], updatedAt: '2024-01-01T00:00:00.000Z' }],
        quickNotes: [{ id: 'qn-in', type: 'text', text: 'Incoming note', createdAt: '2024-01-01T00:00:00.000Z' }],
        artists: { version: 1, artists: [{ id: 'ar-in', name: 'Incoming artist' }], slots: [], events: [] },
        changeLog: [{ op: 'card.update' }]
    };

    const envelope = api.buildTransferEnvelope('all', { local: incoming, now: NOW });
    const result = api.planTransferApply(envelope, 'replace', poisonLocal);

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'replace');
    assert.deepEqual(result.tasks.map(t => t.id), ['card-in']);
    assert.deepEqual(result.quickNotes.map(n => n.id), ['qn-in']);
    assert.deepEqual(result.artists.artists.map(a => a.id), ['ar-in']);
    assert.deepEqual(storageSnapshot(), before, 'replace planning must not write localStorage');
});

test('planTransferApply reports excluded video notes as videosSkipped', () => {
    const incoming = {
        tasks: [],
        quickNotes: [
            { id: 'qn-keep', type: 'text', text: 'keep', createdAt: '2024-01-01T00:00:00.000Z' },
            { id: 'qn-video', type: 'video' },
            { id: 'qn-media', type: 'text', text: 'clip', mediaId: 'm-1' }
        ],
        artists: blankArtists(),
        changeLog: []
    };
    const envelope = api.buildTransferEnvelope('all', { local: incoming, now: NOW });
    assert.equal(envelope.summary.counts.videos, 2);

    const result = api.planTransferApply(envelope, 'replace', {
        tasks: [], quickNotes: [], artists: blankArtists(), changeLog: []
    });
    assert.equal(result.ok, true);
    assert.equal(result.videosSkipped, 2);
    assert.deepEqual(result.quickNotes.map(n => n.id), ['qn-keep']);
});

test('planTransferApply rejects an invalid mode with a clear error', () => {
    const envelope = api.buildTransferEnvelope('all', { local: sampleLocal(), now: NOW });
    const result = api.planTransferApply(envelope, 'upsert', sampleLocal());
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.match(result.error, /merge|replace/i);
});

// ---------------------------------------------------------------------------
// Receive confirmation gate
// ---------------------------------------------------------------------------

test('canConfirmReceive requires a validated envelope and a completed backup', () => {
    const base = { envelopeOk: true, backupDone: true, mode: 'merge', kind: 'media' };
    assert.equal(api.canConfirmReceive(base).ok, true);

    const notValidated = api.canConfirmReceive(Object.assign({}, base, { envelopeOk: false }));
    assert.equal(notValidated.ok, false);
    assert.equal(typeof notValidated.reason, 'string');
    assert.ok(notValidated.reason.length > 0);

    const noBackup = api.canConfirmReceive(Object.assign({}, base, { backupDone: false }));
    assert.equal(noBackup.ok, false);
    assert.equal(typeof noBackup.reason, 'string');
    assert.ok(noBackup.reason.length > 0);

    const badMode = api.canConfirmReceive(Object.assign({}, base, { mode: 'upsert' }));
    assert.equal(badMode.ok, false);
    assert.match(badMode.reason, /merge|replace/i);
});

test('canConfirmReceive allows replace only for a full backup or Everything transfer', () => {
    const full = api.canConfirmReceive({ envelopeOk: true, backupDone: true, mode: 'replace', kind: 'full' });
    assert.equal(full.ok, true);

    for (const kind of ['media', 'changes']) {
        const result = api.canConfirmReceive({ envelopeOk: true, backupDone: true, mode: 'replace', kind });
        assert.equal(result.ok, false, 'replace must fail for kind ' + kind);
        assert.equal(typeof result.reason, 'string');
        assert.match(result.reason, /full|merge/i, 'the reason must steer the user to merge or a full backup');
    }

    const mergeMedia = api.canConfirmReceive({ envelopeOk: true, backupDone: true, mode: 'merge', kind: 'media' });
    assert.equal(mergeMedia.ok, true);
});
