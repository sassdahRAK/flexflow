// Regression tests for the follow-up audit fixes in FlexFlow.html.
// Run with: node --test tests/regressions.test.mjs
//
// Covers:
//   1. erase confirmation cannot hijack a replace import (data loss)
//   2. corrupt task JSON is never silently overwritten at boot
//   3. voice recording uses a timeslice and reports empty captures
//   5. mergeQuickNotes ranks by updatedAt||createdAt and unions replies
//   8. autoMissed is cleared when a row is rescheduled
// plus readStorage's missing/corrupt distinction and saveArtists surfacing.
//
// Hermetic: the shared loader boots the real inline script in a node:vm
// context with in-memory localStorage and DOM stubs. No network, no writes
// outside memory.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { loadApp } from './lib/load-app.mjs';

const app = loadApp();
const { storage } = app;
const run = code => vm.runInContext(code, app.context);

vm.runInContext(`
;globalThis.__reg = {
    TASKS_KEY: TASKS_KEY,
    QUICK_NOTES_KEY: QUICK_NOTES_KEY,
    ARTISTS_KEY: ARTISTS_KEY,
    loadTasks: loadTasks,
    saveInitialData: saveInitialData,
    readStorage: readStorage,
    readStorageArray: readStorageArray,
    corruptStorageKeys: corruptStorageKeys,
    stageImport: stageImport,
    confirmSettingsAction: confirmSettingsAction,
    eraseAllData: eraseAllData,
    mergeQuickNotes: mergeQuickNotes,
    updateCheckTime: updateCheckTime,
    qnStartVoice: qnStartVoice,
    qnFinishRecording: qnFinishRecording,
    saveArtists: saveArtists,
    getTasks: function () { return tasks; },
    setTasks: function (next) { tasks = next; },
    isCorrupt: function () { return storageCorrupt; },
    setCorrupt: function (v) { storageCorrupt = v; },
    getConfirmAction: function () { return settingsConfirmAction; },
    getPending: function () { return settingsPendingImport; },
    getArmed: function () { return settingsConfirmArmed; },
    resetConfirm: function () {
        settingsConfirmAction = null;
        settingsPendingImport = null;
        settingsConfirmArmed = false;
    },
    artistMsgText: function () { return artistMsg; },
    setArtistMsg: function (v) { artistMsg = v; },
    statusText: function (id) { return document.getElementById(id).textContent; },
    statusIsError: function (id) { return document.getElementById(id).classList.contains('is-error') || document.getElementById(id).classList.contains('err'); }
};
`, app.context);

const r = app.context.__reg;

const flush = () => new Promise(resolve => setTimeout(resolve, 10));

// ---------- tiny PASS/FAIL trailer ----------

let total = 0;
let passed = 0;
let failed = 0;

function check(name, fn) {
    total++;
    test(name, async () => {
        try {
            storage.clear();
            r.setCorrupt(false);
            r.resetConfirm();
            await fn();
            passed++;
        } catch (err) {
            failed++;
            throw err;
        }
    });
}

process.on('exit', code => {
    const ok = code === 0 && failed === 0;
    console.log(`\nregressions.test.mjs: ${ok ? 'PASS' : 'FAIL'} (${passed}/${total} checks)`);
});

// ---------- 1. erase vs replace ----------

check('a staged replace clears the armed erase action', async () => {
    run('globalThis.__eraseCalls = 0; applyEraseAll = function () { globalThis.__eraseCalls++; };');
    storage.setItem(r.TASKS_KEY, JSON.stringify([{ id: 'keep-me', title: 'Keep', checklist: [] }]));

    run('eraseAllData();');
    assert.equal(run('settingsConfirmAction && settingsConfirmAction.type'), 'erase',
        'eraseAllData must arm an erase action');

    run(`
        document.getElementById('backupModeSelect').value = 'replace';
        stageImport({ ok: true, kind: 'full', tasks: [{ id: 'backup-card', title: 'From backup', checklist: [] }], quickNotes: [], warnings: [] });
    `);
    assert.equal(r.getConfirmAction(), null, 'stageImport must clear the stale erase action');

    run('confirmSettingsAction();');
    assert.equal(r.getArmed(), true, 'first press arms the replace');
    run('confirmSettingsAction();');
    await flush();

    assert.equal(run('__eraseCalls'), 0, 'applyEraseAll must never run for a replace');
    const stored = JSON.parse(storage.getItem(r.TASKS_KEY) || '[]');
    assert.deepEqual(stored.map(t => t.id), ['backup-card'], 'the backup must win, not an erase');
});

check('a stale erase action cannot survive confirmSettingsAction with a pending import', async () => {
    run('globalThis.__eraseCalls = 0; applyEraseAll = function () { globalThis.__eraseCalls++; };');
    storage.setItem(r.TASKS_KEY, JSON.stringify([{ id: 'keep-me', title: 'Keep', checklist: [] }]));
    // Simulate the historical bad state directly: erase armed plus a replace pending.
    run(`
        settingsConfirmAction = { type: 'erase' };
        settingsPendingImport = { ok: true, kind: 'full', tasks: [{ id: 'backup-card', title: 'From backup', checklist: [] }], quickNotes: [], warnings: [] };
        settingsConfirmArmed = true;
        confirmSettingsAction();
    `);
    await flush();
    assert.equal(run('__eraseCalls'), 0, 'the pending import owns the confirm button');
    const stored = JSON.parse(storage.getItem(r.TASKS_KEY) || '[]');
    assert.deepEqual(stored.map(t => t.id), ['backup-card']);
});

// ---------- 2. corrupt task JSON ----------

check('corrupt task JSON is left untouched and the boot save is skipped', () => {
    const raw = '[{"id":"broken",';   // invalid JSON
    storage.setItem(r.TASKS_KEY, raw);

    r.loadTasks();
    assert.equal(r.isCorrupt(), true, 'parse failure must set storageCorrupt');
    assert.equal(storage.getItem(r.TASKS_KEY), raw, 'loadTasks must not rewrite the raw value');
    assert.match(r.statusText('settingsStatus'), /could not be read/i,
        'a visible warning must be shown');

    const wrote = run('saveInitialData()');
    assert.equal(wrote, false, 'boot save must be skipped while corrupt');
    assert.equal(storage.getItem(r.TASKS_KEY), raw, 'corrupt JSON must survive boot');
});

check('valid storage still loads and saves normally', () => {
    const rows = [{ id: 'ok-card', title: 'OK', checklist: [] }];
    storage.setItem(r.TASKS_KEY, JSON.stringify(rows));
    r.loadTasks();
    assert.equal(r.isCorrupt(), false);
    assert.equal(run('saveInitialData()'), true, 'valid storage may be saved at boot');
    assert.deepEqual(JSON.parse(run('JSON.stringify(__reg.getTasks().map(function (t) { return t.id; }))')), ['ok-card']);
});

// ---------- 3. voice recording ----------

check('voice recording starts with a 1000ms timeslice and reports empty captures', async () => {
    run(`
        globalThis.__startArg = null;
        window.isSecureContext = true;
        function FakeMicRecorder(stream, opts) { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
        FakeMicRecorder.prototype.start = function (timeslice) {
            globalThis.__startArg = timeslice;
            this.state = 'recording';
        };
        FakeMicRecorder.prototype.stop = function () {
            this.state = 'inactive';
            if (typeof this.onstop === 'function') this.onstop();
        };
        globalThis.MediaRecorder = FakeMicRecorder;
        window.MediaRecorder = FakeMicRecorder;
        navigator.mediaDevices = {
            getUserMedia: function () { return Promise.resolve({ getTracks: function () { return []; } }); }
        };
        qnRecorder = null;
        qnRecChunks = [];
        qnRecCancelled = false;
        qnStartVoice();
    `);
    await flush();

    assert.equal(run('__startArg'), 1000, 'MediaRecorder.start must receive a 1000ms timeslice');

    run(`
        qnRecorder = null;
        qnRecChunks = [];
        qnRecCancelled = false;
        document.getElementById('qnStatus').textContent = '';
        qnFinishRecording();
    `);
    assert.match(r.statusText('qnStatus'), /No audio data was captured/i,
        'an empty capture must surface an explicit error, not return silently');
    assert.equal(r.statusIsError('qnStatus'), true, 'the error must be styled');

    // Clean up the 60s auto-stop timer and the fake stream.
    run(`
        if (qnRecTimer) { clearInterval(qnRecTimer); qnRecTimer = null; }
        if (qnRecAutoStop) { clearTimeout(qnRecAutoStop); qnRecAutoStop = null; }
        qnStopRecStream();
    `);
});

// ---------- 5. mergeQuickNotes ----------

check('mergeQuickNotes ranks by updatedAt, not the older createdAt', () => {
    const local = {
        id: 'n1', text: 'local edited',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-02-01T00:00:00Z',
        replies: [{ id: 'r1', text: 'local r1', createdAt: '2026-01-05T00:00:00Z', updatedAt: '2026-01-05T00:00:00Z' }]
    };
    // Remote has a NEWER createdAt but an OLDER updatedAt: the old code would
    // have let it win and discard the local edit.
    const remote = {
        id: 'n1', text: 'remote older',
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-01-15T00:00:00Z',
        replies: [
            { id: 'r1', text: 'remote r1 older', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
            { id: 'r2', text: 'remote r2', createdAt: '2026-01-04T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z' }
        ]
    };
    run(`globalThis.__mergeArgs = ${JSON.stringify({ local: [local], remote: [remote] })};`);
    const merged = JSON.parse(run(
        'JSON.stringify(__reg.mergeQuickNotes(__mergeArgs.local, __mergeArgs.remote))'
    ));
    const note = merged.notes.find(n => n.id === 'n1');
    assert.equal(note.text, 'local edited', 'the edit (updatedAt) must win over the newer createdAt');
    const ids = (note.replies || []).map(reply => reply.id).sort();
    assert.deepEqual(ids, ['r1', 'r2'], 'replies must be unioned by id');
    const r1 = note.replies.find(reply => reply.id === 'r1');
    assert.equal(r1.text, 'local r1', 'the newest copy of a shared reply wins');
    assert.equal(merged.stats.updated, 0);
    assert.equal(merged.stats.skipped, 1);
});

check('mergeQuickNotes keeps local replies when a newer remote note wins', () => {
    const local = {
        id: 'n2', text: 'old local',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-10T00:00:00Z',
        replies: [{ id: 'rA', text: 'from local', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }]
    };
    const remote = {
        id: 'n2', text: 'new remote',
        createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-20T00:00:00Z',
        replies: [{ id: 'rB', text: 'from remote', createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' }]
    };
    run(`globalThis.__mergeArgs = ${JSON.stringify({ local: [local], remote: [remote] })};`);
    const merged = JSON.parse(run(
        'JSON.stringify(__reg.mergeQuickNotes(__mergeArgs.local, __mergeArgs.remote))'
    ));
    const note = merged.notes.find(n => n.id === 'n2');
    assert.equal(note.text, 'new remote');
    assert.deepEqual((note.replies || []).map(reply => reply.id).sort(), ['rA', 'rB'],
        'remote win must not drop local replies');
});

// ---------- 8. autoMissed cleared on reschedule ----------

const missedItem = {
    id: 'i-missed', text: 'late', status: 'missed', autoMissed: true,
    start: '2099-01-04T07:00', duration: 15, end: '2099-01-04T07:15'
};

function seedItem(item) {
    run(`__reg.setTasks(${JSON.stringify([{ id: 'card-reg', title: 'Card', checklist: [item] }])});`);
}

function itemAfter(hhmm, duration) {
    seedItem(missedItem);
    run(`__reg.updateCheckTime('card-reg', 'i-missed', '2099-01-04T${hhmm}', ${duration});`);
    return JSON.parse(run('JSON.stringify(__reg.getTasks()[0].checklist[0])'));
}

check('rescheduling clears autoMissed and an auto-set missed lock', () => {
    const item = JSON.parse(JSON.stringify(missedItem));
    item.statusLocked = true;
    seedItem(item);
    run(`__reg.updateCheckTime('card-reg', 'i-missed', '2099-01-04T09:00', 30);`);
    const after = JSON.parse(run('JSON.stringify(__reg.getTasks()[0].checklist[0])'));
    assert.equal(!!after.autoMissed, false, 'autoMissed must be cleared');
    assert.equal(!!after.statusLocked, false, 'an auto-set missed lock must be released');
    assert.equal(after.start, '2099-01-04T09:00');
    assert.equal(after.duration, 30);
});

check('a manual lock is preserved when the row is rescheduled', () => {
    const item = JSON.parse(JSON.stringify(missedItem));
    item.autoMissed = false;
    item.status = 'checked';
    item.statusLocked = true;
    seedItem(item);
    run(`__reg.updateCheckTime('card-reg', 'i-missed', '2099-01-04T09:00', 30);`);
    const after = JSON.parse(run('JSON.stringify(__reg.getTasks()[0].checklist[0])'));
    assert.equal(after.statusLocked, true, 'a user lock is not an auto-miss');
});

// ---------- 7. readStorage distinction + saveArtists surfacing ----------

check('readStorage distinguishes missing from corrupt', () => {
    storage.removeItem('reg-probe');
    assert.equal(run('__reg.readStorage("reg-probe").state'), 'missing');

    storage.setItem('reg-probe', '{not json');
    assert.equal(run('__reg.readStorage("reg-probe").state'), 'corrupt');
    assert.deepEqual(
        JSON.parse(run('JSON.stringify(__reg.corruptStorageKeys([__reg.TASKS_KEY, "reg-probe"]))')),
        ['reg-probe'], 'a corrupt key must be reported, a missing one must not');

    storage.setItem('reg-probe', '[1,2]');
    assert.equal(run('__reg.readStorage("reg-probe").state'), 'ok');
    assert.deepEqual(JSON.parse(run('JSON.stringify(__reg.readStorageArray("reg-probe"))')), [1, 2]);
});

check('saveArtists surfaces a quota failure through artistMsg', () => {
    r.setArtistMsg('');
    const original = storage.setItem;
    storage.setItem = function (key, value) {
        if (String(key) === r.ARTISTS_KEY) {
            const err = new Error('quota');
            err.name = 'QuotaExceededError';
            throw err;
        }
        return original.call(this, key, value);
    };
    try {
        assert.equal(run('__reg.saveArtists()'), false, 'a failed write must return false');
    } finally {
        storage.setItem = original;
    }
    assert.match(r.artistMsgText(), /could not be saved/i, 'the failure must be visible in artistMsg');
});
