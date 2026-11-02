// Regression tests for timeline re-chaining during drag reorder.
// Run with: node --test tests/reorder.test.mjs
//
// The shared loader only exports the security/import surface, so this file
// evaluates a second script in the same vm context to reach the real
// rechainCardsFrom / rechainChecklistFrom helpers and the live `tasks` store.
// No DOM library, no network and no writes outside the loader's in-memory
// localStorage stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { loadApp } from './lib/load-app.mjs';

const app = loadApp();

vm.runInContext(`
;globalThis.__reorder = {
    setTasks: function (next) { tasks = next; },
    getTasks: function () { return tasks; },
    rechainCardsFrom: rechainCardsFrom,
    rechainChecklistFrom: rechainChecklistFrom,
    sortCardsByTime: sortCardsByTime,
    sortChecklistByStart: sortChecklistByStart,
    startValueOfCard: startValueOfCard,
    getCardWindow: getCardWindow,
    parseWallClock: parseWallClock,
    EMPTY_TIME_LABEL: EMPTY_TIME_LABEL
};
`, app.context);

const r = app.context.__reorder;

const DAY = '2026-11-03';
const at = hhmm => `${DAY}T${hhmm}`;

// ---------- fixtures ----------

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

function makeChecklistItem(id, hhmm, durationMin) {
    return {
        id,
        text: id,
        start: hhmm ? at(hhmm) : '',
        duration: durationMin == null ? '' : String(durationMin),
        end: '',
        time: ''
    };
}

function makeChecklistCard(items) {
    return { id: 'card-1', title: 'Card', checklist: items };
}

// ---------- helpers mirroring the drag handlers ----------

// handlePointerUp moves the card in the live array, then cascades from
// Math.min(fromIndex, dropIndex). The handler swaps neighbours step by step;
// splice is the same permutation.
function dragCardTo(id, toIndex) {
    const list = r.getTasks();
    const from = list.findIndex(t => t.id === id);
    assert.ok(from >= 0, `card ${id} must exist`);
    assert.ok(toIndex >= 0 && toIndex < list.length, 'destination in range');
    const snapshotStarts = list.map(t => r.startValueOfCard(t));
    const draggedStart = snapshotStarts[from];
    const [moved] = list.splice(from, 1);
    list.splice(toIndex, 0, moved);
    r.setTasks(list);
    r.rechainCardsFrom(Math.min(from, toIndex), snapshotStarts, draggedStart);
    return { from, to: toIndex, snapshotStarts, draggedStart };
}

function dragItemTo(task, itemId, toIndex) {
    const from = task.checklist.findIndex(c => c.id === itemId);
    assert.ok(from >= 0, `item ${itemId} must exist`);
    assert.ok(toIndex >= 0 && toIndex < task.checklist.length, 'destination in range');
    const snapshotStarts = task.checklist.map(c => String(c.start || ''));
    const draggedStart = snapshotStarts[from];
    const [moved] = task.checklist.splice(from, 1);
    task.checklist.splice(toIndex, 0, moved);
    r.rechainChecklistFrom(task, Math.min(from, toIndex), snapshotStarts, draggedStart);
    r.sortChecklistByStart(task);
    return { from, to: toIndex, snapshotStarts, draggedStart };
}

function startsById() {
    const map = {};
    r.getTasks().forEach(task => { map[task.id] = r.startValueOfCard(task); });
    return map;
}

function itemStartsById(task) {
    const map = {};
    task.checklist.forEach(item => { map[item.id] = String(item.start || ''); });
    return map;
}

function assertNoDuplicateStarts(list) {
    const timed = list.map(t => r.startValueOfCard(t)).filter(Boolean);
    assert.equal(new Set(timed).size, timed.length, `duplicate starts: ${timed.join(', ')}`);
}

function assertNoOverlap(list) {
    for (let i = 1; i < list.length; i++) {
        const prev = r.getCardWindow(list[i - 1]);
        const cur = r.getCardWindow(list[i]);
        if (prev.end && cur.start) {
            assert.ok(
                prev.end.getTime() <= cur.start.getTime(),
                `${list[i - 1].id} ends after ${list[i].id} starts`
            );
        }
    }
}

function assertNoChecklistOverlap(task) {
    const timed = task.checklist.filter(item => r.parseWallClock(item.start));
    for (let i = 1; i < timed.length; i++) {
        const prevEnd = r.parseWallClock(timed[i - 1].end);
        const curStart = r.parseWallClock(timed[i].start);
        if (prevEnd && curStart) {
            assert.ok(
                prevEnd.getTime() <= curStart.getTime(),
                `${timed[i - 1].id} ends after ${timed[i].id} starts`
            );
        }
    }
}

// ---------- card reorder ----------

test('card drag down then back restores the exact original starts', () => {
    r.setTasks([
        makeCard('A', '10:00', 15),
        makeCard('B', '10:15', 15),
        makeCard('C', '10:30', 15)
    ]);
    const originals = { A: at('10:00'), B: at('10:15'), C: at('10:30') };

    dragCardTo('A', 1);
    let live = r.getTasks();
    assert.deepEqual(live.map(t => t.id), ['B', 'A', 'C']);

    // This is the old-behaviour guard: a dropIndex-only cascade left B at
    // 10:15 while it re-timed A to 10:15 as well.
    assert.notEqual(
        r.startValueOfCard(live[0]),
        r.startValueOfCard(live[1]),
        'displaced card must not keep the dragged card\'s old start'
    );
    assert.equal(r.startValueOfCard(live[0]), at('10:00'));
    assert.equal(r.startValueOfCard(live[1]), at('10:15'));
    assertNoDuplicateStarts(live);
    assertNoOverlap(live);

    dragCardTo('A', 0);
    live = r.getTasks();
    assert.deepEqual(live.map(t => t.id), ['A', 'B', 'C']);
    assert.deepEqual(startsById(), originals, 'down-then-back must restore the original starts');
    assertNoDuplicateStarts(live);
    assertNoOverlap(live);
});

test('card two-step drag down and back restores the exact original starts', () => {
    r.setTasks([
        makeCard('A', '10:00', 15),
        makeCard('B', '10:15', 15),
        makeCard('C', '10:30', 15)
    ]);
    const originals = { A: at('10:00'), B: at('10:15'), C: at('10:30') };

    dragCardTo('A', 2);
    let live = r.getTasks();
    assert.deepEqual(live.map(t => t.id), ['B', 'C', 'A']);
    assertNoDuplicateStarts(live);
    assertNoOverlap(live);

    dragCardTo('A', 0);
    live = r.getTasks();
    assert.deepEqual(live.map(t => t.id), ['A', 'B', 'C']);
    assert.deepEqual(startsById(), originals);
});

test('card reorder restores exactly for a mixed-duration queue', () => {
    // 60 / 15 / 15 minutes. The starts are chained: A 10:00-11:00,
    // B 11:00-11:15, C 11:15-11:30.
    r.setTasks([
        makeCard('A', '10:00', 60),
        makeCard('B', '11:00', 15),
        makeCard('C', '11:15', 15)
    ]);
    const originals = { A: at('10:00'), B: at('11:00'), C: at('11:15') };

    dragCardTo('A', 1);
    let live = r.getTasks();
    assert.deepEqual(live.map(t => t.id), ['B', 'A', 'C']);
    assert.equal(r.startValueOfCard(live[0]), at('10:00'));
    assert.equal(r.startValueOfCard(live[1]), at('10:15'));
    assert.equal(r.startValueOfCard(live[2]), at('11:15'));
    assertNoDuplicateStarts(live);
    assertNoOverlap(live);

    dragCardTo('A', 0);
    assert.deepEqual(startsById(), originals);
});

test('rechain is idempotent for a coherent chained queue', () => {
    r.setTasks([
        makeCard('A', '10:00', 60),
        makeCard('B', '11:00', 15),
        makeCard('C', '11:15', 15)
    ]);
    const before = startsById();
    const list = r.getTasks();
    const snapshot = list.map(t => r.startValueOfCard(t));
    r.rechainCardsFrom(0, snapshot, snapshot[0]);
    assert.deepEqual(startsById(), before);
});

test('card without a start stays blank and is skipped by the cascade', () => {
    // N is parked between the timed cards. The cascade must leave it blank and
    // must not spend its 15 minutes on the cursor (otherwise C becomes 10:45).
    const noTime = makeCard('N', null);
    r.setTasks([
        makeCard('A', '10:00', 15),
        makeCard('B', '10:15', 15),
        noTime,
        makeCard('C', '10:30', 15)
    ]);

    dragCardTo('A', 1);
    const map = startsById();
    assert.equal(map.N, '', 'no-time card must keep a blank start');
    assert.equal(noTime.checklist[0].end, '', 'no-time card must keep a blank end');
    assert.equal(map.B, at('10:00'));
    assert.equal(map.A, at('10:15'));
    assert.equal(map.C, at('10:30'), 'the blank card must not consume the cascade cursor');
});

// ---------- checklist reorder ----------

test('checklist item drag down then back restores the exact original starts', () => {
    const task = makeChecklistCard([
        makeChecklistItem('i-A', '10:00', 15),
        makeChecklistItem('i-B', '10:15', 15),
        makeChecklistItem('i-C', '10:30', 15)
    ]);
    r.setTasks([task]);
    const originals = { 'i-A': at('10:00'), 'i-B': at('10:15'), 'i-C': at('10:30') };

    dragItemTo(task, 'i-A', 1);
    assert.deepEqual(task.checklist.map(i => i.id), ['i-B', 'i-A', 'i-C']);

    // Old-behaviour guard: dropIndex-only cascading left i-B and i-A at 10:15.
    assert.notEqual(task.checklist[0].start, task.checklist[1].start);
    assert.equal(task.checklist[0].start, at('10:00'));
    assert.equal(task.checklist[1].start, at('10:15'));
    assertNoChecklistOverlap(task);

    dragItemTo(task, 'i-A', 0);
    assert.deepEqual(task.checklist.map(i => i.id), ['i-A', 'i-B', 'i-C']);
    assert.deepEqual(itemStartsById(task), originals, 'down-then-back must restore the original starts');
    assertNoChecklistOverlap(task);
});

test('checklist two-step drag down and back restores the exact original starts', () => {
    const task = makeChecklistCard([
        makeChecklistItem('i-A', '10:00', 15),
        makeChecklistItem('i-B', '10:15', 15),
        makeChecklistItem('i-C', '10:30', 15)
    ]);
    r.setTasks([task]);
    const originals = { 'i-A': at('10:00'), 'i-B': at('10:15'), 'i-C': at('10:30') };

    dragItemTo(task, 'i-A', 2);
    assert.deepEqual(task.checklist.map(i => i.id), ['i-B', 'i-C', 'i-A']);
    assertNoChecklistOverlap(task);

    dragItemTo(task, 'i-A', 0);
    assert.deepEqual(task.checklist.map(i => i.id), ['i-A', 'i-B', 'i-C']);
    assert.deepEqual(itemStartsById(task), originals);
});

test('checklist reorder restores exactly for mixed durations', () => {
    const task = makeChecklistCard([
        makeChecklistItem('i-A', '10:00', 60),
        makeChecklistItem('i-B', '11:00', 15),
        makeChecklistItem('i-C', '11:15', 15)
    ]);
    r.setTasks([task]);
    const originals = { 'i-A': at('10:00'), 'i-B': at('11:00'), 'i-C': at('11:15') };

    dragItemTo(task, 'i-A', 1);
    assert.deepEqual(task.checklist.map(i => i.id), ['i-B', 'i-A', 'i-C']);
    assert.equal(task.checklist[0].start, at('10:00'));
    assert.equal(task.checklist[1].start, at('10:15'));
    assert.equal(task.checklist[2].start, at('11:15'));
    assertNoChecklistOverlap(task);

    dragItemTo(task, 'i-A', 0);
    assert.deepEqual(itemStartsById(task), originals);
});

test('checklist item without a start stays blank and is skipped', () => {
    const blank = makeChecklistItem('i-N', null);
    const task = makeChecklistCard([
        makeChecklistItem('i-A', '10:00', 15),
        makeChecklistItem('i-B', '10:15', 15),
        blank,
        makeChecklistItem('i-C', '10:30', 15)
    ]);
    r.setTasks([task]);

    dragItemTo(task, 'i-A', 1);
    const map = itemStartsById(task);
    assert.equal(map['i-N'], '', 'no-time item must keep a blank start');
    assert.equal(blank.end, '');
    assert.equal(blank.time, r.EMPTY_TIME_LABEL);
    assert.equal(map['i-B'], at('10:00'));
    assert.equal(map['i-A'], at('10:15'));
    assert.equal(map['i-C'], at('10:30'), 'the blank item must not consume the cascade cursor');
});

// Concise PASS/FAIL trailer so a bare `node tests/reorder.test.mjs` run is
// readable; node --test reports the same status per test.
process.on('exit', code => {
    console.log(`\nreorder.test.mjs: ${code === 0 ? 'PASS' : 'FAIL'}`);
});
