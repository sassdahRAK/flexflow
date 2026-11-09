// Feature regression tests for FlexFlow.html.
// Run with: node --test tests/features.test.mjs
//
// Covers the artist "Add artist" control, quick-note editing and threaded
// replies (append/delete/persistence/sanitisation), inline-handler escaping in
// the quick-note render, and a light guard on the drag-reorder cascade.
//
// Hermetic: the shared loader boots the real inline script in a node:vm
// context with in-memory localStorage and DOM stubs. No network, no writes
// outside memory.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { loadApp, decodeHtml } from './lib/load-app.mjs';

const app = loadApp();
const { api, storage, html, script } = app;

// The loader only exports the security/import surface. Evaluate one extra
// script in the same context to reach the live quick-note / artist helpers.
vm.runInContext(`
;globalThis.__features = {
    getNotes: function () { return quickNotes; },
    setNotes: function (next) { quickNotes = next; },
    resetUi: function () {
        qnEditingId = null;
        qnEditDraft = '';
        qnReplyingId = null;
        qnReplyDraft = '';
        qnPendingDeleteId = null;
        qnPendingReplyDeleteId = null;
    },
    qnSaveEdit: qnSaveEdit,
    qnSendReply: qnSendReply,
    deleteQuickNoteReply: deleteQuickNoteReply,
    qnRepliesHtml: qnRepliesHtml,
    loadQuickNotes: loadQuickNotes,
    QN_MAX_REPLIES: QN_MAX_REPLIES,
    QN_MAX_REPLY_TEXT: QN_MAX_REPLY_TEXT,
    QUICK_NOTES_KEY: QUICK_NOTES_KEY,
    addArtist: addArtist,
    getArtistsData: function () { return artistsData; },
    ARTISTS_KEY: ARTISTS_KEY
};
`, app.context);

const f = app.context.__features;

// ---------- tiny PASS/FAIL trailer with counts ----------

let total = 0;
let passed = 0;
let failed = 0;

function featureTest(name, fn) {
    total++;
    test(name, async t => {
        try {
            await fn(t);
            passed++;
        } catch (err) {
            failed++;
            throw err;
        }
    });
}

process.on('exit', code => {
    const ok = code === 0 && failed === 0 && passed === total;
    console.log(`\nfeatures.test.mjs: ${ok ? 'PASS' : 'FAIL'} (${passed}/${total} passed)`);
});

// ---------- helpers ----------

const NOTE_KEY = api.STORAGE_KEYS.notes;
const ISO = '2026-01-01T00:00:00.000Z';

function storedNotes() {
    const raw = storage.getItem(NOTE_KEY);
    return raw == null ? null : JSON.parse(raw);
}

function resetNotes(notes) {
    f.resetUi();
    storage.removeItem(NOTE_KEY);
    f.setNotes(notes || []);
}

function makeTextNote(overrides) {
    return Object.assign({
        id: 'qn-test-1',
        type: 'text',
        text: 'original text',
        imageUrl: '',
        audioDataUrl: '',
        audioMime: '',
        lat: null,
        lng: null,
        createdAt: ISO,
        replies: []
    }, overrides || {});
}

// ---------- artist add button: markup + CSS ----------

featureTest('artist add control is a single full-width dashed button in the Info tab', () => {
    const infoView = /<section id="infoView"[^>]*>([\s\S]*?)<\/section>/.exec(html);
    assert.ok(infoView, 'Info tab section must exist');
    assert.ok(infoView[1].includes('id="artistAddBtn"'), 'add control must live in the Info tab');

    const buttonTag = /<button\b[^>]*id="artistAddBtn"[^>]*>/.exec(html);
    assert.ok(buttonTag, 'artist add button markup must exist');
    const tag = buttonTag[0];
    assert.match(tag, /class="ar-add-btn"/, 'add control must use the ar-add-btn class');
    assert.match(tag, /type="button"/);
    assert.match(tag, /onclick="addArtist\(\)"/, 'add control must call addArtist()');

    // Exactly one full-width button, not a pair of half-width controls.
    assert.equal((html.match(/class="ar-add-btn"/g) || []).length, 1);

    const cssBlock = /\.ar-add-btn\s*\{([^}]*)\}/.exec(html);
    assert.ok(cssBlock, '.ar-add-btn CSS rule must exist');
    const css = cssBlock[1];
    assert.match(css, /width\s*:\s*100%/, '.ar-add-btn must span the full content width');
    assert.match(css, /border\s*:\s*[^;]*dashed/, '.ar-add-btn must have a dashed border');
});

featureTest('addArtist creates exactly one artist and one linked slot, and persists both', () => {
    const data = f.getArtistsData();
    const beforeArtists = data.artists.length;
    const beforeSlots = data.slots.length;

    f.addArtist();

    const after = f.getArtistsData();
    assert.equal(after.artists.length, beforeArtists + 1, 'one artist must be created');
    assert.equal(after.slots.length, beforeSlots + 1, 'one slot must be created');

    const artist = after.artists[after.artists.length - 1];
    const slot = after.slots[after.slots.length - 1];
    assert.equal(artist.name, 'New artist');
    assert.match(artist.id, api.SAFE_ID_RE);
    assert.equal(slot.artistId, artist.id, 'slot must point at the new artist');
    assert.match(slot.id, api.SAFE_ID_RE);

    const stored = JSON.parse(storage.getItem(f.ARTISTS_KEY));
    assert.equal(stored.artists.length, after.artists.length, 'artists must be persisted');
    assert.equal(stored.slots.length, after.slots.length, 'slots must be persisted');
});

// ---------- quick note edit ----------

featureTest('quick-note text render exposes an Edit action bound to the note id', () => {
    f.resetUi();
    const note = makeTextNote({ id: 'qn-ui-1', text: 'hello world' });
    const bubble = api.qnBubbleHtml(note);

    assert.ok(bubble.includes('data-action="qn-edit"'), 'text notes must render an Edit action');
    assert.ok(bubble.includes('data-note-id="qn-ui-1"'), 'Edit action must carry the note id');
    assert.ok(bubble.includes('>Edit</button>'), 'Edit action must be labelled Edit');
    assert.ok(bubble.includes('<div class="qn-text">hello world</div>'));
});

featureTest('quick-note edit saves text + updatedAt, persists it and renders it escaped', () => {
    const note = makeTextNote({ id: 'qn-edit-1', text: 'before' });
    resetNotes([note]);

    const hostile = '<img src=x onerror=alert(1)> & "quoted"';
    f.qnSaveEdit(note.id, hostile);

    assert.equal(note.text, hostile, 'edit-save must update note.text');
    assert.equal(typeof note.updatedAt, 'string');
    assert.notEqual(note.updatedAt, '', 'edit-save must set updatedAt');
    assert.doesNotThrow(() => new Date(note.updatedAt).toISOString());

    const persisted = storedNotes();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].text, hostile, 'edited text must be persisted');
    assert.equal(persisted[0].updatedAt, note.updatedAt, 'updatedAt must be persisted');

    const rendered = api.qnBubbleHtml(note);
    assert.ok(
        rendered.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;'),
        'edited text must be HTML-escaped in the re-render'
    );
    assert.ok(!rendered.includes('<img src=x onerror=alert(1)>'), 'raw hostile markup must not be rendered');
    assert.ok(rendered.includes('· edited'), 'edited notes must show the edited marker');
});

featureTest('quick-note edit survives a reload through sanitizeImportedNotes', () => {
    const note = makeTextNote({ id: 'qn-edit-2', text: 'before' });
    resetNotes([note]);
    const hostile = '<b onmouseover=alert(1)>after</b>';
    f.qnSaveEdit(note.id, hostile);

    // Simulate a fresh page load: drop the live array, read storage back.
    f.resetUi();
    f.setNotes([]);
    f.loadQuickNotes();

    const loaded = f.getNotes();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'qn-edit-2');
    assert.equal(loaded[0].text, hostile);
    assert.equal(loaded[0].updatedAt, note.updatedAt);
    assert.ok(api.qnBubbleHtml(loaded[0]).includes('&lt;b onmouseover=alert(1)&gt;after&lt;/b&gt;'));
});

// ---------- quick note replies ----------

featureTest('replies append with rep- ids and render inside .qn-replies', () => {
    const note = makeTextNote({ id: 'qn-reply-1', text: 'note body' });
    resetNotes([note]);

    f.qnSendReply(note.id, 'first reply');
    assert.equal(note.replies.length, 1);
    const first = note.replies[0];
    assert.match(first.id, /^rep-/, 'reply ids must use the rep- prefix');
    assert.match(first.id, api.SAFE_ID_RE);
    assert.equal(first.text, 'first reply');
    assert.equal(typeof first.createdAt, 'string');
    assert.equal(typeof first.updatedAt, 'string');

    let persisted = storedNotes();
    assert.equal(persisted[0].replies.length, 1, 'first reply must be persisted');

    f.qnSendReply(note.id, 'second reply');
    assert.equal(note.replies.length, 2);
    const second = note.replies[1];
    assert.match(second.id, /^rep-/);
    assert.notEqual(second.id, first.id);

    persisted = storedNotes();
    assert.equal(persisted[0].replies.length, 2, 'second reply must be persisted');

    const repliesHtml = f.qnRepliesHtml(note);
    assert.ok(repliesHtml.startsWith('<div class="qn-replies">'));
    assert.ok(repliesHtml.includes('first reply'));
    assert.ok(repliesHtml.includes('second reply'));
    assert.ok(repliesHtml.includes(`data-reply-id="${first.id}"`));
    assert.ok(repliesHtml.includes(`data-reply-id="${second.id}"`));

    const bubble = api.qnBubbleHtml(note);
    assert.ok(bubble.includes(repliesHtml), 'replies must render inside the note bubble');
});

featureTest('deleting one reply removes only that reply and the survivor persists', () => {
    const note = makeTextNote({ id: 'qn-reply-2', text: 'note body' });
    resetNotes([note]);

    f.qnSendReply(note.id, 'keep me');
    f.qnSendReply(note.id, 'delete me');
    assert.equal(note.replies.length, 2);
    const keep = note.replies[0];
    const drop = note.replies[1];

    f.deleteQuickNoteReply(note.id, drop.id);

    assert.equal(note.replies.length, 1, 'only one reply must be removed');
    assert.equal(note.replies[0].id, keep.id);
    assert.equal(note.replies[0].text, 'keep me');

    let persisted = storedNotes();
    assert.equal(persisted[0].replies.length, 1);
    assert.equal(persisted[0].replies[0].text, 'keep me');

    // Reload from storage: the surviving reply must still be there.
    f.resetUi();
    f.setNotes([]);
    f.loadQuickNotes();
    const loaded = f.getNotes();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].replies.length, 1);
    assert.equal(loaded[0].replies[0].id, keep.id);
    assert.equal(loaded[0].replies[0].text, 'keep me');

    const rendered = api.qnBubbleHtml(loaded[0]);
    assert.ok(rendered.includes('<div class="qn-replies">'));
    assert.ok(rendered.includes('keep me'));
    assert.ok(!rendered.includes('delete me'), 'deleted reply must not render');
});

// ---------- reply sanitisation ----------

featureTest('sanitizeImportedNotes drops replies that are not an array', () => {
    const badValues = ['nope', {}, 42, true, null];
    for (const bad of badValues) {
        const [note] = api.sanitizeImportedNotes([makeTextNote({ replies: bad })]);
        assert.equal(
            Object.prototype.hasOwnProperty.call(note, 'replies'),
            false,
            `replies=${JSON.stringify(bad)} must be dropped`
        );
    }
});

featureTest('sanitizeImportedNotes regenerates unsafe and duplicate reply ids via safeId', () => {
    const rawReplies = [
        { id: "r');alert(1)", text: 'one' },
        { id: 'dup', text: 'two' },
        { id: 'dup', text: 'three' },
        { id: '__proto__', text: 'four' },
        { id: '', text: 'five' }
    ];
    const [note] = api.sanitizeImportedNotes([makeTextNote({ replies: rawReplies })]);

    assert.equal(note.replies.length, rawReplies.length, 'no non-empty reply may be dropped');
    const ids = note.replies.map(reply => reply.id);
    for (const id of ids) {
        assert.equal(typeof id, 'string');
        assert.match(id, api.SAFE_ID_RE, `reply id ${JSON.stringify(id)} must be safe`);
        assert.ok(!/['";<>\s]/.test(id), `reply id ${JSON.stringify(id)} must contain no breakout chars`);
        assert.ok(api.RESERVED_ID_KEYS.indexOf(id) < 0, 'reserved ids must be prefixed');
    }
    assert.equal(new Set(ids).size, ids.length, 'duplicate reply ids must be regenerated');
    assert.notEqual(ids[0], "r');alert(1)");
    assert.equal(ids[3], 'rep-__proto__', 'reserved reply id must use the rep- prefix');
});

featureTest('sanitizeImportedNotes caps reply count and reply text length', () => {
    assert.equal(f.QN_MAX_REPLIES, 200);
    assert.equal(f.QN_MAX_REPLY_TEXT, 2000);

    const many = Array.from({ length: 250 }, (_, i) => ({ id: 'r-' + i, text: 'reply ' + i }));
    const [capped] = api.sanitizeImportedNotes([makeTextNote({ replies: many })]);
    assert.equal(capped.replies.length, 200, 'reply count must be capped at 200');
    assert.equal(capped.replies[0].text, 'reply 0');
    assert.equal(capped.replies[199].text, 'reply 199');

    const longText = 'x'.repeat(2500);
    const [longNote] = api.sanitizeImportedNotes([
        makeTextNote({ replies: [{ id: 'r-long', text: longText }] })
    ]);
    assert.equal(longNote.replies.length, 1);
    assert.equal(longNote.replies[0].text.length, 2000, 'reply text must be capped at 2000 chars');
    assert.equal(longNote.replies[0].text, longText.slice(0, 2000));
});

featureTest('sanitizeImportedNotes drops replies whose text is empty', () => {
    const [note] = api.sanitizeImportedNotes([makeTextNote({
        replies: [
            { id: 'r1', text: 'keep' },
            { id: 'r2', text: '   ' },
            { id: 'r3', text: '' },
            { id: 'r4', text: null },
            { id: 'r5' }
        ]
    })]);

    assert.equal(note.replies.length, 1);
    assert.equal(note.replies[0].id, 'r1');
    assert.equal(note.replies[0].text, 'keep');
});

featureTest('sanitizeImportedNotes never pollutes Object.prototype for __proto__ reply ids', () => {
    // JSON.parse creates an own "__proto__" data property, which is the shape
    // an imported media/backup file can carry.
    const payload = JSON.parse('{"id":"qn-proto","type":"text","text":"n","replies":[' +
        '{"id":"__proto__","text":"x","polluted":"yes"},' +
        '{"__proto__":{"polluted":true},"id":"r-2","text":"y"}' +
        ']}');

    const [note] = api.sanitizeImportedNotes([payload]);

    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(note.replies.length, 2);
    for (const reply of note.replies) {
        assert.notEqual(reply.id, '__proto__');
        assert.match(reply.id, api.SAFE_ID_RE);
        assert.equal(Object.prototype.hasOwnProperty.call(reply, '__proto__'), false);
    }
    assert.equal(note.replies[0].text, 'x');
    assert.equal(note.replies[1].text, 'y');
});

// ---------- inline-handler safety in the quick-note render ----------

featureTest('quick-note render wraps every inline-handler interpolation in escapeJsArg', () => {
    const start = script.indexOf('function qnRepliesHtml');
    const end = script.indexOf('function renderQuickNotes');
    assert.ok(start >= 0 && end > start, 'quick-note render functions must be locatable');
    const region = script.slice(start, end);

    assert.ok(!/\$\{\s*note\.id\s*\}/.test(region), 'raw ${note.id} interpolation must not be used');
    assert.ok(!/\$\{\s*reply\.id\s*\}/.test(region), 'raw ${reply.id} interpolation must not be used');

    const handlerRe = /\bon[a-z]+\s*=\s*"([^"]*)"/g;
    let handlers = 0;
    let interpolations = 0;
    let match;
    while ((match = handlerRe.exec(region)) !== null) {
        handlers++;
        const body = match[1];
        const interpRe = /\$\{([^}]*)\}/g;
        let interp;
        while ((interp = interpRe.exec(body)) !== null) {
            interpolations++;
            assert.match(
                interp[1].trim(),
                /^escapeJsArg\(/,
                `inline handler interpolation must use escapeJsArg: ${body}`
            );
        }
    }
    assert.ok(handlers >= 3, `expected the dynamic quick-note handlers, found ${handlers}`);
    assert.ok(interpolations >= 3, `expected escaped id interpolations, found ${interpolations}`);
});

featureTest('quick-note handler arguments survive a hostile note id as a single JSON string', () => {
    f.resetUi();
    const hostile = 'x"\'();alert(1)//<b>';
    const note = makeTextNote({ id: hostile, text: 'safe body' });
    const rendered = api.qnBubbleHtml(note);

    const handlerRe = /onclick="([^"]*)"/g;
    const handlers = [];
    let match;
    while ((match = handlerRe.exec(rendered)) !== null) handlers.push(decodeHtml(match[1]));

    assert.ok(handlers.length >= 2, 'text note must render inline handlers');
    for (const handler of handlers) {
        const call = /^(shareQuickNote|qnRequestDelete)\((.+)\)$/.exec(handler);
        assert.ok(call, `unexpected handler shape: ${handler}`);
        assert.equal(JSON.parse(call[2]), hostile, 'handler argument must round-trip as one JSON string');
    }

    const video = makeTextNote({ id: hostile, type: 'video', durationMs: 1000, text: '' });
    const videoHtml = api.qnBubbleHtml(video);
    const play = /onclick="qnPlayVideo\(([^"]*)\)"/.exec(videoHtml);
    assert.ok(play, 'video note must render a play handler');
    const playArgs = decodeHtml(play[1]);
    assert.match(playArgs, /^this,\s*/);
    assert.equal(JSON.parse(playArgs.replace(/^this,\s*/, '')), hostile);
});

// ---------- reorder regression guard (full matrix lives in reorder.test.mjs) ----------

featureTest('drag reorder still cascades from Math.min(from, to) for cards and items', () => {
    assert.match(
        html,
        /Math\.min\(\s*fromIndex\s*,\s*dropIndex\s*\)/,
        'card reorder must cascade from the earlier of fromIndex/dropIndex'
    );
    assert.match(
        html,
        /Math\.min\(\s*itemFrom\s*,\s*itemTo\s*\)/,
        'checklist reorder must cascade from the earlier of itemFrom/itemTo'
    );
    assert.match(html, /rechainCardsFrom\(\s*cascadeStart\s*,\s*snapshot\.starts\s*,\s*snapshot\.draggedStart\s*,\s*draggedId\s*\)/);
    assert.match(html, /rechainChecklistFrom\(\s*task\s*,\s*cascadeStart\s*,\s*info\.starts\s*,\s*info\.draggedStart\s*\)/);
});
