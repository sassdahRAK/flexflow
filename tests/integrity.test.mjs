// Regression tests for the integrity fixes:
//   1. dragging an untimed card must not re-time the timed queue,
//   2. Replace without artists must clear this device's artists,
//   3. a generated id must not produce a false plan-vs-stored mismatch,
//   4. the transfer change log must be planned and merged within its cap.
// Run with: node --test tests/integrity.test.mjs
//
// Like reorder.test.mjs this loads the real inline script with the shared
// node:vm loader, then evaluates a second script in the same context to reach
// module-private helpers. Storage is the loader's in-memory stub: no network,
// no disk writes.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { loadApp } from './lib/load-app.mjs';

const app = loadApp();
const { api, storage } = app;

vm.runInContext(`
;globalThis.__integrity = {
    setTasks: function (next) { tasks = next; },
    getTasks: function () { return tasks; },
    rechainCardsFrom: rechainCardsFrom,
    startValueOfCard: startValueOfCard,
    applyArtistsPayload: applyArtistsPayload,
    tfCollectIdsFromEnvelope: tfCollectIdsFromEnvelope,
    tfExpectedIdsFromPlan: tfExpectedIdsFromPlan,
    tfMissingExpectedIds: tfMissingExpectedIds,
    applyTransferChangeLog: applyTransferChangeLog,
    CHANGE_LOG_CAP: CHANGE_LOG_CAP,
    getChangeLog: function () { return changeLog; },
    setChangeLog: function (next) { changeLog = next; },
    getChangeSeq: function () { return changeSeq; },
    setChangeSeq: function (next) { changeSeq = next; }
};
`, app.context);

const r = app.context.__integrity;

const NOW = '2026-05-01T00:00:00.000Z';
const DAY = '2026-11-03';
const at = hhmm => `${DAY}T${hhmm}`;

function blankArtists() {
    return { version: 1, artists: [], slots: [], events: [] };
}

function makeCard(id, hhmm, durationMin) {
    return {
        id,
        title: id,
        description: '',
        checklist: [{
            id: id + '-item',
            text: id,
            start: hhmm ? at(hhmm) : '',
            duration: durationMin == null ? '' : String(durationMin),
            end: '',
            time: ''
        }]
    };
}

function startsById() {
    const map = {};
    r.getTasks().forEach(task => { map[task.id] = r.startValueOfCard(task); });
    return map;
}

function localSnapshot(data) {
    return {
        tasks: data.tasks || [],
        quickNotes: data.quickNotes || [],
        artists: data.artists || blankArtists(),
        changeLog: data.changeLog || []
    };
}

// Rebuilds a valid checksum after a test mutates a signed envelope.
function reseal(envelope) {
    envelope.checksum = api.transferChecksum(
        JSON.stringify([envelope.version, envelope.scope, envelope.data])
    );
    return envelope;
}

// ---------------------------------------------------------------------------
// BUG 4: an untimed card dragged down must not rewrite the timed queue
// ---------------------------------------------------------------------------

test('dragging an untimed card down leaves the timed starts unchanged', () => {
    // N is parked above a timed queue. Dragging it DOWN means the cascade
    // index is the index of B (the card shifted up), so a guard that tests
    // tasks[cascadeStartIndex] sees a timed card and re-times C.
    r.setTasks([
        makeCard('N', null),
        makeCard('B', '10:00', 15),
        makeCard('C', '10:30', 15)
    ]);

    const list = r.getTasks();
    const from = list.findIndex(t => t.id === 'N');
    const snapshotStarts = list.map(t => r.startValueOfCard(t));
    const draggedStart = snapshotStarts[from];
    const [moved] = list.splice(from, 1);
    list.splice(1, 0, moved); // [B, N, C]
    r.setTasks(list);

    r.rechainCardsFrom(Math.min(from, 1), snapshotStarts, draggedStart, 'N');

    const starts = startsById();
    assert.equal(starts.N, '', 'the untimed card must stay blank');
    assert.equal(starts.B, at('10:00'), 'the timed card above must keep its start');
    assert.equal(starts.C, at('10:30'), 'the timed queue below must not be re-timed');
});

test('the 3-argument form still cascades from the cascade index', () => {
    // Compatibility guard for callers without a dragged id: a timed card
    // dragged down must still re-chain the cards after it.
    r.setTasks([
        makeCard('A', '10:00', 15),
        makeCard('B', '10:15', 15),
        makeCard('C', '10:30', 15)
    ]);

    const list = r.getTasks();
    const snapshotStarts = list.map(t => r.startValueOfCard(t));
    const draggedStart = snapshotStarts[0];
    const [moved] = list.splice(0, 1);
    list.splice(1, 0, moved); // [B, A, C]
    r.setTasks(list);

    r.rechainCardsFrom(0, snapshotStarts, draggedStart);

    const starts = startsById();
    assert.equal(starts.B, at('10:00'));
    assert.equal(starts.A, at('10:15'));
    assert.equal(starts.C, at('10:30'));
});

// ---------------------------------------------------------------------------
// BUG 2: Replace must clear artists when the envelope carries none
// ---------------------------------------------------------------------------

test('replace with no artists plans an empty list and applying it clears artists', () => {
    const envelope = api.buildTransferEnvelope('all', {
        local: localSnapshot({ tasks: [], quickNotes: [], changeLog: [] }),
        now: NOW
    });
    // Simulate an envelope that never carried an artist payload at all.
    delete envelope.data.artists;
    reseal(envelope);

    const plan = api.planTransferApply(envelope, 'replace', localSnapshot({}));
    assert.equal(plan.ok, true, plan.error);
    assert.equal(
        plan.artists.artists.length,
        0,
        'replace with no artists must plan an empty list'
    );

    // Seed this device with an artist, then prove the plan clears it.
    storage.clear();
    storage.setItem(api.STORAGE_KEYS.artists, JSON.stringify({
        version: 1,
        artists: [{ id: 'ar-seed', name: 'Seed artist' }],
        slots: [],
        events: []
    }));

    r.applyArtistsPayload(plan.artists, false);

    const stored = JSON.parse(storage.getItem(api.STORAGE_KEYS.artists));
    assert.deepEqual(stored.artists, [], 'replace must remove this device\'s artists');
});

// ---------------------------------------------------------------------------
// BUG 1: a task without an id must not create a false verification mismatch
// ---------------------------------------------------------------------------

test('a task with a missing id yields no plan-vs-expected id mismatch', () => {
    const envelope = api.buildTransferEnvelope('all', {
        local: localSnapshot({ tasks: [{ title: 'No id', checklist: [] }] }),
        now: NOW
    });

    const plan = api.planTransferApply(envelope, 'replace', localSnapshot({}));
    assert.equal(plan.ok, true, plan.error);
    assert.equal(typeof plan.tasks[0].id, 'string');
    assert.ok(plan.tasks[0].id.length > 0, 'the plan must mint one id');

    // Write exactly what the plan contains, then verify against the same ids.
    storage.clear();
    assert.equal(api.applyImport({ tasks: plan.tasks, quickNotes: plan.quickNotes }, false), true);

    const expected = r.tfExpectedIdsFromPlan(plan);
    assert.equal(expected.tasks[0], plan.tasks[0].id);
    assert.equal(r.tfMissingExpectedIds(expected), 0, 'the written plan ids must verify');

    // The old path re-sanitised the raw envelope and minted a different id.
    const rawIds = r.tfCollectIdsFromEnvelope(envelope);
    assert.notEqual(
        rawIds.tasks[0],
        plan.tasks[0].id,
        're-sanitising the raw envelope produces a different generated id'
    );
    assert.equal(
        r.tfMissingExpectedIds(rawIds),
        1,
        'the raw-envelope path is exactly the false-mismatch bug the plan path fixes'
    );
});

// ---------------------------------------------------------------------------
// BUG 3: the change log is planned, deduped on merge, and capped
// ---------------------------------------------------------------------------

test('planTransferApply returns the sanitized incoming change log', () => {
    const incomingLog = [
        { seq: 7, at: '2026-01-01T00:00:00.000Z', op: 'card.update', cardId: 'card-1', data: { title: 'x' } },
        { seq: 8, at: '2026-01-02T00:00:00.000Z', op: 'item.status', cardId: 'card-1', itemId: 'i-1', data: {} },
        { seq: 9 } // malformed: no op, must be dropped
    ];
    const envelope = api.buildTransferEnvelope('all', {
        local: localSnapshot({ changeLog: incomingLog }),
        now: NOW
    });

    for (const mode of ['replace', 'merge']) {
        const plan = api.planTransferApply(envelope, mode, localSnapshot({}));
        assert.equal(plan.ok, true, plan.error);
        assert.ok(Array.isArray(plan.changeLog), mode + ' plan must return a change log array');
        assert.equal(plan.changeLog.length, 2, mode + ' plan must drop malformed entries');
        assert.deepEqual(plan.changeLog.map(rec => rec.op), ['card.update', 'item.status']);
        assert.equal(plan.changeLog[0].cardId, 'card-1');
        assert.equal(plan.changeLog[1].itemId, 'i-1');
    }
});

test('merging the change log dedupes on at|op|cardId|itemId and renumbers seq', () => {
    r.setChangeLog([
        { seq: 4, at: '2026-01-01T00:00:00.000Z', op: 'card.update', cardId: 'card-a', data: {} }
    ]);
    r.setChangeSeq(5);

    r.applyTransferChangeLog([
        // Same identity as the existing entry: must not be appended.
        { at: '2026-01-01T00:00:00.000Z', op: 'card.update', cardId: 'card-a', data: { title: 'dupe' } },
        { at: '2026-01-02T00:00:00.000Z', op: 'card.update', cardId: 'card-b', data: {} }
    ], 'merge');

    const log = r.getChangeLog();
    assert.equal(log.length, 2, 'the duplicate operation must be skipped');
    assert.deepEqual(log.map(rec => rec.seq), [1, 2], 'seq must be renumbered from 1');
    assert.equal(log[1].cardId, 'card-b');
    assert.equal(r.getChangeSeq(), 3);
});

test('merging respects CHANGE_LOG_CAP and keeps the newest entries', () => {
    const cap = r.CHANGE_LOG_CAP;
    assert.equal(typeof cap, 'number');
    assert.ok(cap > 0);

    const seeded = Array.from({ length: cap }, (_, i) => ({
        seq: i + 1,
        at: '2026-01-01T00:00:00.000Z',
        op: 'card.update',
        cardId: 'old-' + i,
        data: {}
    }));
    r.setChangeLog(seeded);
    r.setChangeSeq(cap + 1);

    const incoming = Array.from({ length: 10 }, (_, i) => ({
        at: '2026-02-01T00:00:00.000Z',
        op: 'note.create',
        cardId: 'new-' + i,
        data: {}
    }));
    r.applyTransferChangeLog(incoming, 'merge');

    const log = r.getChangeLog();
    assert.equal(log.length, cap, 'the log must be capped');
    assert.equal(log[log.length - 1].cardId, 'new-9', 'the newest entry must survive');
    assert.equal(log[0].cardId, 'old-10', 'only the oldest entries were dropped');
    assert.equal(log[0].seq, 1);
    assert.equal(log[log.length - 1].seq, cap);
    assert.equal(r.getChangeSeq(), cap + 1);
});
