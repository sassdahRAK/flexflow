// Security regression tests for FlexFlow.html.
// Run with: node --test tests/security.test.mjs
//
// The app script is loaded into a node:vm context with DOM/localStorage stubs,
// so these tests exercise the real source without a browser or network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadApp, decodeHtml } from './lib/load-app.mjs';
import { buildZip, zipArrayBuffer } from './lib/zip.mjs';

const { api, storage } = loadApp();

// A payload that breaks out of a single-quoted inline handler.
const QUOTE_BREAKOUT = "x');alert(1);//";
const ATTR_BREAKOUT = 'x" onmouseover="alert(1)';
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];
const utf8 = value => new TextEncoder().encode(value);

function assertSafeId(id) {
    assert.equal(typeof id, 'string');
    assert.ok(api.SAFE_ID_RE.test(id), `expected ${JSON.stringify(id)} to match SAFE_ID_RE`);
    assert.ok(!/['";<>]/.test(id), `expected ${JSON.stringify(id)} to contain no quote/semicolon/tag chars`);
    assert.ok(id.length <= 80, 'id must be at most 80 chars');
}

test('safeId rewrites quote-breakout ids deterministically', () => {
    const first = api.safeId(QUOTE_BREAKOUT, 'card-');
    const second = api.safeId(QUOTE_BREAKOUT, 'card-');
    assertSafeId(first);
    assert.equal(first, second, 'safeId must be deterministic for artist<->slot linkage');
    assert.ok(!first.includes("'"));
    assert.ok(!first.includes(';'));
    assert.ok(!first.includes('('));
    assert.ok(!first.includes(')'));
    assert.ok(!first.includes('/'));
});

test('safeId neutralises attribute-breakout ids', () => {
    const id = api.safeId(ATTR_BREAKOUT, 'card-');
    assertSafeId(id);
    assert.ok(!id.includes('"'));
    assert.ok(!id.includes(' '));
    assert.ok(!id.includes('='));
});

test('safeId prefixes reserved prototype keys', () => {
    for (const key of RESERVED_KEYS) {
        const plain = api.safeId(key);
        assert.notEqual(plain, key);
        assert.equal(plain, 'id-' + key);
        assertSafeId(plain);

        const prefixed = api.safeId(key, 'card-');
        assert.notEqual(prefixed, key);
        assert.equal(prefixed, 'card-' + key);
        assertSafeId(prefixed);
    }
});

test('safeId falls back to a generated id for empty input', () => {
    const id = api.safeId('', 'qn-');
    assert.ok(id.startsWith('qn-'));
    assertSafeId(id);
});

test('escapeJsArg HTML-escapes and remains a valid JS string argument', () => {
    const payload = "a');alert(1)//";
    const encoded = api.escapeJsArg(payload);

    assert.ok(encoded.includes('&quot;'), 'expected a JSON-quoted value to be HTML-escaped');
    assert.ok(!encoded.includes("'"), 'raw single quotes must not survive');
    assert.ok(!encoded.includes('"'), 'raw double quotes must not survive');
    assert.ok(!encoded.includes('<'));
    assert.ok(!encoded.includes('>'));

    const decoded = decodeHtml(encoded);
    assert.equal(decoded[0], '"');
    assert.equal(decoded[decoded.length - 1], '"');
    assert.equal(JSON.parse(decoded), payload);
});

test('sanitizeImportedTask rewrites ids and de-duplicates checklist ids', () => {
    const card = api.sanitizeImportedTask({
        id: QUOTE_BREAKOUT,
        title: '<img src=x onerror=alert(1)>',
        description: 'desc',
        coverUrl: 'javascript:alert(1)',
        checklist: [
            { id: "a');alert(1)", text: 'one', status: 'checked' },
            { id: 'dup', text: 'two' },
            { id: 'dup', text: 'three' }
        ],
        detailPoints: ['ok', 42, { bad: true }]
    });

    assert.ok(card);
    assertSafeId(card.id);
    assert.notEqual(card.id, QUOTE_BREAKOUT);

    const ids = card.checklist.map(item => item.id);
    ids.forEach(assertSafeId);
    assert.equal(new Set(ids).size, ids.length, 'duplicate checklist ids must be regenerated');
    assert.equal(card.coverUrl, '');
    assert.deepEqual(card.detailPoints, ['ok']);
    assert.equal(card.checklist.length, 3);
});

test('sanitizeImportedNotes keeps video, forces safe ids, rejects bad URLs and null locations', () => {
    const notes = api.sanitizeImportedNotes([
        {
            id: '__proto__',
            type: 'video',
            text: '<b>note</b>',
            imageUrl: 'javascript:alert(1)',
            lat: null,
            lng: ''
        },
        {
            id: "n');alert(1)",
            type: 'image',
            imageUrl: 'ftp://example.com/a.png',
            lat: '11.5',
            lng: '104.9'
        },
        {
            id: 'img-ok',
            type: 'image',
            imageUrl: 'https://example.com/a.png'
        }
    ]);

    const [video, ftpNote, okNote] = notes;
    assert.equal(video.type, 'video');
    assert.notEqual(video.id, '__proto__');
    assert.ok(video.id.startsWith('qn-'));
    assertSafeId(video.id);
    assert.equal(video.imageUrl, '');
    assert.equal(video.lat, null, 'lat:null must stay null (not a location)');
    assert.equal(video.lng, null, 'lng:"" must stay null (not a location)');

    assertSafeId(ftpNote.id);
    assert.equal(ftpNote.imageUrl, '');
    assert.equal(ftpNote.lat, 11.5);
    assert.equal(ftpNote.lng, 104.9);

    assert.equal(okNote.imageUrl, 'https://example.com/a.png');
});

test('normaliseArtist and normaliseSlot keep artist<->slot linkage for hostile ids', () => {
    const artist = api.normaliseArtist({
        id: QUOTE_BREAKOUT,
        name: 'Artist',
        members: [{ id: ATTR_BREAKOUT, name: 'Member' }]
    });
    const slot = api.normaliseSlot({ id: QUOTE_BREAKOUT, artistId: QUOTE_BREAKOUT });

    assert.ok(artist);
    assert.ok(slot);
    assertSafeId(artist.id);
    assertSafeId(slot.id);
    assertSafeId(slot.artistId);
    assert.equal(slot.artistId, artist.id, 'slot must point at the sanitized artist id');
    assertSafeId(artist.members[0].id);
});

test('normaliseSlot rejects entries without an artistId', () => {
    assert.equal(api.normaliseSlot({ id: 'slot-1' }), null);
    assert.equal(api.normaliseSlot(null), null);
});

test('sanitizeCoverUrl accepts only http(s) and data:image URLs', () => {
    const accepted = [
        'http://example.com/a.png',
        'https://example.com/a.png',
        'data:image/png;base64,AAAA'
    ];
    // Any data:image/* is allowed by the contract (it is only used as an <img> src).
    const dataImages = [
        'data:image/svg+xml,<svg onload=alert(1)>',
        'data:image/gif;base64,R0lGOD'
    ];
    const rejected = [
        'javascript:alert(1)',
        'javascript:alert(1)//',
        'JaVaScRiPt:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'data:text/javascript,alert(1)',
        'blob:https://example.com/1234',
        'file:///etc/passwd',
        'java\nscript:alert(1)',
        'java\tscript:alert(1)',
        ' java\nscript:alert(1) '
    ];

    for (const url of accepted.slice(0, 2)) {
        assert.equal(api.sanitizeCoverUrl(url), url);
    }
    assert.ok(api.sanitizeCoverUrl(accepted[2]).startsWith('data:image/png'));
    dataImages.forEach(url => assert.ok(api.sanitizeCoverUrl(url).startsWith('data:image/')));

    for (const url of rejected) {
        assert.equal(api.sanitizeCoverUrl(url), '', `expected ${JSON.stringify(url)} to be rejected`);
    }
});

test('readZipBuffer parses but never explodes on reserved or duplicate entry names', () => {
    const zip = zipArrayBuffer([
        { name: '__proto__', bytes: 'x' },
        { name: 'constructor', bytes: 'x' },
        { name: 'prototype', bytes: 'x' },
        { name: 'media.json', bytes: '{"notes":{}}' },
        { name: 'media.json', bytes: '{"notes":{}}' }
    ]);

    let parsed;
    assert.doesNotThrow(() => { parsed = api.readZipBuffer(zip); });
    assert.equal(parsed.ok, true, parsed.message);

    // handleBackupFile funnels every entry through putBackupEntry, which is the
    // reserved-key/duplicate choke point.
    const map = Object.create(null);
    assert.doesNotThrow(() => {
        parsed.entries.forEach(entry => api.putBackupEntry(map, entry.name, entry.bytes));
    });

    for (const key of RESERVED_KEYS) {
        assert.equal(Object.prototype.hasOwnProperty.call(map, key), false, `${key} must be dropped`);
    }
    assert.equal(Object.keys(map).length, 1, 'duplicate names must collapse to one entry');
    assert.ok(Object.prototype.hasOwnProperty.call(map, 'media.json'));
    assert.equal({}.polluted, undefined);
});

test('media.json with __proto__ note ids does not pollute Object.prototype', () => {
    // JSON.parse creates an own "__proto__" data property; Object.keys sees it.
    const media = JSON.parse('{"notes":{"__proto__":{"type":"text","text":"a"},"constructor":{"type":"text","text":"b"},"a b":{"type":"text","text":"c"},"a_b":{"type":"text","text":"d"}}}');
    const map = Object.create(null);
    map['media.json'] = utf8(JSON.stringify(media));

    let result;
    assert.doesNotThrow(() => { result = api.inspectBackupEntries(map); });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.kind, 'media');

    const ids = result.quickNotes.map(note => note.id);
    ids.forEach(assertSafeId);
    assert.ok(ids.every(id => RESERVED_KEYS.indexOf(id) < 0), 'reserved note ids must be prefixed');
    assert.equal(new Set(ids).size, ids.length, 'colliding sanitized ids must be regenerated');
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
});

test('sanitising reserved-key payloads never pollutes Object.prototype', () => {
    api.sanitizeImportedTask({
        id: '__proto__',
        checklist: [{ id: '__proto__' }, { id: 'constructor' }],
        detailPoints: ['x']
    });
    api.sanitizeImportedNotes([{ id: '__proto__' }, { id: 'constructor' }]);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
});

test('qnBubbleHtml does not render a Maps link for null coordinates', () => {
    const withoutLocation = api.qnBubbleHtml({ id: 'qn-1', type: 'location', lat: null, lng: null, text: 'no coords' });
    assert.ok(withoutLocation.length > 0);
    assert.ok(!withoutLocation.includes('google.com/maps'));
    assert.ok(!withoutLocation.includes('qn-maps'));

    const withLocation = api.qnBubbleHtml({ id: 'qn-2', type: 'location', lat: 11.5564, lng: 104.9282, text: 'here' });
    assert.ok(withLocation.includes('google.com/maps'));
});

test('replayChangeOps skips ops whose cardId or itemId is unsafe', () => {
    const now = new Date().toISOString();
    const tasks = [{
        id: 'card-ok',
        updatedAt: '2000-01-01T00:00:00.000Z',
        checklist: [{ id: 'item-ok', text: 'original' }],
        detailPoints: []
    }];
    const ops = [
        { op: 'card.update', seq: 1, at: now, cardId: QUOTE_BREAKOUT, data: { fields: { title: 'pwned' } } },
        { op: 'item.update', seq: 2, at: now, cardId: 'card-ok', itemId: 'a b', data: { fields: { text: 'pwned' } } },
        { op: 'item.status', seq: 3, at: now, cardId: 'card-ok', itemId: "i');alert(1)", data: { status: 'checked' } }
    ];

    const result = api.replayChangeOps(ops, tasks, []);
    assert.equal(result.summary.applied, 0);
    assert.equal(result.summary.skipped, 3);
    assert.equal(result.tasks[0].title, undefined);
    assert.equal(result.tasks[0].checklist[0].text, 'original');
    assert.equal(result.tasks[0].checklist[0].status, undefined);

    // Positive control: a safe op still applies.
    const applied = api.replayChangeOps([
        { op: 'card.star', seq: 4, at: '2999-01-01T00:00:00.000Z', cardId: 'card-ok', data: { starred: true } }
    ], tasks, []);
    assert.equal(applied.summary.applied, 1);
    assert.equal(applied.tasks[0].starred, true);
});

test('applyImport sanitises both replace and merge payloads before persisting', () => {
    api.stubRenderFns();
    const keys = api.STORAGE_KEYS;

    for (const isMerge of [false, true]) {
        storage.clear();
        const ok = api.applyImport({
            tasks: [{
                id: QUOTE_BREAKOUT,
                title: 'T',
                checklist: [{ id: '__proto__', text: 'a' }, { id: '__proto__', text: 'b' }]
            }],
            quickNotes: [{
                id: '__proto__',
                type: 'video',
                imageUrl: 'javascript:alert(1)',
                lat: null,
                lng: ''
            }]
        }, isMerge);

        assert.equal(ok, true, 'applyImport should succeed');
        const storedTasks = JSON.parse(storage.getItem(keys.tasks));
        const storedNotes = JSON.parse(storage.getItem(keys.notes));

        assert.equal(storedTasks.length, 1);
        assertSafeId(storedTasks[0].id);
        const itemIds = storedTasks[0].checklist.map(item => item.id);
        itemIds.forEach(assertSafeId);
        assert.equal(new Set(itemIds).size, itemIds.length);

        assert.equal(storedNotes.length, 1);
        assertSafeId(storedNotes[0].id);
        assert.equal(storedNotes[0].type, 'video');
        assert.equal(storedNotes[0].imageUrl, '');
        assert.equal(storedNotes[0].lat, null);
        assert.equal(storedNotes[0].lng, null);
    }
});

test('a ZIP round-trip with hostile media ids persists only safe note ids', () => {
    api.stubRenderFns();
    const keys = api.STORAGE_KEYS;
    storage.clear();

    const media = JSON.parse('{"notes":{"__proto__":{"type":"text","text":"a"},"constructor":{"type":"text","text":"b"}}}');
    const parsed = api.readZipBuffer(zipArrayBuffer([
        { name: 'media.json', bytes: JSON.stringify(media) }
    ]));
    assert.equal(parsed.ok, true, parsed.message);
    const map = Object.create(null);
    parsed.entries.forEach(entry => api.putBackupEntry(map, entry.name, entry.bytes));
    const inspected = api.inspectBackupEntries(map);
    assert.equal(inspected.ok, true, inspected.message);

    const ok = api.applyImport({ tasks: [], quickNotes: inspected.quickNotes }, true);
    assert.equal(ok, true);
    const storedNotes = JSON.parse(storage.getItem(keys.notes));
    assert.equal(storedNotes.length, 2);
    storedNotes.forEach(note => assertSafeId(note.id));
    assert.equal({}.polluted, undefined);
});

test('ZIP with duplicate backup.json entries reads without throwing', () => {
    const backup = JSON.stringify({ version: 1, tasks: [], quickNotes: [] });
    const zip = zipArrayBuffer([
        { name: 'backup.json', bytes: backup },
        { name: 'backup.json', bytes: backup }
    ]);
    let parsed;
    assert.doesNotThrow(() => { parsed = api.readZipBuffer(zip); });
    assert.equal(parsed.ok, true, parsed.message);
    const map = Object.create(null);
    parsed.entries.forEach(entry => api.putBackupEntry(map, entry.name, entry.bytes));
    assert.equal(Object.keys(map).length, 1);
    assert.equal(api.inspectBackupEntries(map).ok, true);
});

test('buildZip fixture itself is readable (guards the ZIP helper)', () => {
    const parsed = api.readZipBuffer(zipArrayBuffer([{ name: 'backup.json', bytes: '{}' }]));
    assert.equal(parsed.ok, true, parsed.message);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].name, 'backup.json');
    assert.equal(buildZip([{ name: 'a', bytes: 'b' }]).length > 0, true);
});
