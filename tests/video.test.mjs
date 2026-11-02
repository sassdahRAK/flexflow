// Video capture regression tests for FlexFlow.html.
// Run with: node --test tests/video.test.mjs
//
// Hermetic: the app script runs in a node:vm context from tests/lib/load-app.mjs
// with in-memory DOM/localStorage stubs. MediaRecorder, mediaPut and addQuickNote
// are replaced inside that same context so no browser or network is needed.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { loadApp } from './lib/load-app.mjs';

const { context, document: documentStub } = loadApp();

const run = code => vm.runInContext(code, context, { filename: 'video-test.vm.js' });
const modal = documentStub.getElementById('qnVideoModal');
const msg = documentStub.getElementById('qnVideoMsg');

let passed = 0;
let failed = 0;

function check(name, fn) {
    test(name, async () => {
        try {
            await fn();
            passed++;
            console.log('PASS ' + name);
        } catch (err) {
            failed++;
            console.log('FAIL ' + name + ': ' + (err && err.message ? err.message : err));
            throw err;
        }
    });
}

after(() => {
    console.log(`video.test summary: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
});

check('qnToggleVideoRecord starts MediaRecorder with a truthy timeslice', () => {
    run(`
        globalThis.__captured = { startArgs: null };
        function FakeRecorder(stream, opts) {
            this.stream = stream;
            this.state = 'inactive';
            this.mimeType = (opts && opts.mimeType) || '';
            this.ondataavailable = null;
            this.onstop = null;
        }
        FakeRecorder.isTypeSupported = function () { return true; };
        FakeRecorder.prototype.start = function () {
            __captured.startArgs = Array.prototype.slice.call(arguments);
            this.state = 'recording';
        };
        FakeRecorder.prototype.stop = function () {
            this.state = 'inactive';
            if (typeof this.onstop === 'function') this.onstop();
        };
        globalThis.MediaRecorder = FakeRecorder;
        window.MediaRecorder = FakeRecorder;
        qnVideoRecorder = null;
        qnVideoChunks = [];
        qnVideoStream = { getTracks: function () { return []; } };
        qnToggleVideoRecord();
    `);

    const args = run('__captured.startArgs');
    assert.ok(Array.isArray(args), 'MediaRecorder.start must have been called');
    assert.ok(args.length >= 1, 'MediaRecorder.start must receive an argument');
    assert.ok(args[0], 'timeslice must be truthy');
    assert.equal(args[0], 1000, 'timeslice should be 1000ms');

    // Clean up the 30s auto-stop timer and fake recorder.
    run('qnCloseVideo(); qnVideoStream = null;');
});

check('empty capture keeps the video modal open and shows an error', () => {
    run(`
        globalThis.__calls = { media: 0, notes: 0 };
        mediaPut = function () { __calls.media++; return Promise.resolve(); };
        addQuickNote = function () { __calls.notes++; return { id: 'note-x' }; };
        qnVideoRecorder = null;
        qnVideoChunks = [];
        qnVideoStream = { getTracks: function () { return []; } };
        document.getElementById('qnVideoModal').hidden = false;
        document.getElementById('qnVideoMsg').textContent = '';
        document.getElementById('qnVideoMsg').classList.remove('is-error');
        qnFinishVideoRecording();
    `);

    assert.equal(modal.hidden, false, 'modal must stay open when no data was captured');
    assert.match(msg.textContent, /No video data/, 'a clear error must be shown');
    assert.equal(msg.classList.contains('is-error'), true, 'error styling must be applied');
    assert.equal(run('__calls.media'), 0, 'mediaPut must not run for an empty capture');
    assert.equal(run('__calls.notes'), 0, 'no note must be added for an empty capture');
    assert.equal(run('qnVideoChunks.length'), 0, 'chunks must be cleared for retry');
    assert.equal(run('qnVideoRecorder'), null, 'recorder must be cleared for retry');
    assert.equal(run('!!qnVideoStream'), true, 'camera stream should stay alive so Record works again');

    run('qnVideoStream = null;');
});

check('a zero-byte blob is rejected without saving', () => {
    run(`
        globalThis.__calls = { media: 0, notes: 0 };
        mediaPut = function () { __calls.media++; return Promise.resolve(); };
        addQuickNote = function () { __calls.notes++; return { id: 'note-zero' }; };
        qnVideoRecorder = null;
        qnVideoChunks = [ new Blob([], { type: 'video/webm' }) ];
        qnVideoStream = null;
        document.getElementById('qnVideoModal').hidden = false;
        document.getElementById('qnVideoMsg').textContent = '';
        qnFinishVideoRecording();
    `);

    assert.equal(modal.hidden, false, 'modal must stay open for a zero-byte blob');
    assert.match(msg.textContent, /No video data/);
    assert.equal(run('__calls.media'), 0);
    assert.equal(run('__calls.notes'), 0);
});

check('a non-empty blob is stored and adds a video note', async () => {
    run(`
        globalThis.__calls = { media: 0, notes: 0 };
        globalThis.__putRecord = null;
        globalThis.__lastNote = null;
        mediaPut = function (record) { __calls.media++; __putRecord = record; return Promise.resolve(); };
        addQuickNote = function (fields) { __calls.notes++; __lastNote = fields; return { id: 'note-vid-1' }; };
        qnVideoRecorder = { mimeType: 'video/webm', state: 'inactive' };
        qnVideoChunks = [ new Blob(['abc'], { type: 'video/webm' }) ];
        qnVideoStartedAt = Date.now() - 1234;
        qnVideoStream = { getTracks: function () { return []; } };
        document.getElementById('qnVideoModal').hidden = false;
        document.getElementById('qnVideoMsg').textContent = '';
    `);

    await run(`(async function () {
        qnFinishVideoRecording();
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
    })()`);

    assert.equal(run('__calls.media'), 1, 'mediaPut must be called once');
    assert.equal(run('__calls.notes'), 1, 'addQuickNote must be called once');
    assert.equal(run('__putRecord.blob.size'), 3, 'blob must be non-empty before saving');
    assert.equal(run('__putRecord.kind'), 'video');
    const note = run('__lastNote');
    assert.equal(note.type, 'video');
    assert.equal(note.mediaId, run('__putRecord.id'));
    assert.ok(note.durationMs >= 1200 && note.durationMs <= 5000, 'duration should be recorded');
    assert.equal(modal.hidden, true, 'modal closes after a successful save');
    assert.equal(run('qnVideoChunks.length'), 0);
});

check('qnScrollNoteIntoView scrolls the matching note bubble', () => {
    const listEl = documentStub.getElementById('quickNoteList');
    const originalQsa = listEl.querySelectorAll;
    const scrolled = [];
    let wrongScrolled = false;
    const other = {
        dataset: { noteId: 'some-other-id' },
        scrollIntoView() { wrongScrolled = true; }
    };
    const target = {
        dataset: { noteId: 'note-vid-9' },
        scrollIntoView(opts) { scrolled.push(opts); }
    };
    listEl.querySelectorAll = () => [other, target];
    try {
        run('qnScrollNoteIntoView("note-vid-9")');
        assert.equal(wrongScrolled, false, 'only the matching note should scroll');
        assert.equal(scrolled.length, 1);
        assert.equal(scrolled[0].block, 'nearest');
        assert.equal(scrolled[0].behavior, 'smooth');
        run('qnScrollNoteIntoView("missing-id")');
        assert.equal(scrolled.length, 1, 'a missing note must not throw or scroll');
    } finally {
        listEl.querySelectorAll = originalQsa;
    }
});
