// Performance regression tests for FlexFlow.html.
// Run with: node tests/perf.test.mjs   (or: node --test tests/perf.test.mjs)
//
// The shared loader (tests/lib/load-app.mjs) only exposes the security/import
// surface, so this file evaluates a second script in the same vm context to
// expose the internal hot-path helpers. No DOM library, no network, no writes
// outside the loader's in-memory localStorage stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { loadApp } from './lib/load-app.mjs';

const app = loadApp();

vm.runInContext(`
;globalThis.__perf = (function () {
    const originalGetCambodiaNow = getCambodiaNow;

    // Pre-optimisation parser, kept here so the benchmark compares against the
    // real baseline inside the same realm (no cross-realm call overhead).
    function naiveParseWallClock(value) {
        const m = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2}))?/.exec(String(value || '').trim());
        if (!m) return null;
        const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0);
        if (!isFinite(d.getTime())) return null;
        if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3] ||
            d.getHours() !== +m[4] || d.getMinutes() !== +m[5]) {
            return null;
        }
        return d;
    }

    // 200 distinct, valid wall-clock strings, built once per process.
    const benchStrings = (function () {
        const out = [];
        for (let i = 0; i < 200; i++) {
            const day = 1 + Math.floor(i / 24);
            const hour = i % 24;
            const minute = (i * 7) % 60;
            out.push('2026-11-' + String(day).padStart(2, '0') +
                'T' + String(hour).padStart(2, '0') +
                ':' + String(minute).padStart(2, '0'));
        }
        return out;
    })();

    return {
        parseWallClock: parseWallClock,
        naiveParseWallClock: naiveParseWallClock,
        // Runs the whole pass inside the vm and returns a sink so the JIT
        // cannot discard the work. Host times a single call.
        benchParse: function (iterations, useNaive) {
            const fn = useNaive ? naiveParseWallClock : parseWallClock;
            let sink = 0;
            for (let it = 0; it < iterations; it++) {
                for (let i = 0; i < benchStrings.length; i++) {
                    const parsed = fn(benchStrings[i]);
                    sink += parsed ? (parsed.getTime() & 1) : 0;
                }
            }
            return sink;
        },
        getCambodiaNow: getCambodiaNow,
        getCambodiaNowFormatter: function () { return cambodiaNowFormatter; },
        getCambodiaClockFormatter: function () { return cambodiaClockFormatter; },
        computeStatus: computeStatus,
        computeCardBadge: computeCardBadge,
        computeCardStatusSummary: computeCardStatusSummary,
        refreshStatuses: refreshStatuses,
        ensureSortOrder: ensureSortOrder,
        currentSortSignature: currentSortSignature,
        getTasks: function () { return tasks; },
        setTasks: function (next) { tasks = next; },
        setNow: function (ms) { getCambodiaNow = function () { return new Date(ms); }; },
        restoreNow: function () { getCambodiaNow = originalGetCambodiaNow; },
        resetPerfCaches: function () {
            cambodiaNowFormatter = null;
            cambodiaNowFormatterFailed = false;
            cambodiaClockFormatter = null;
            cambodiaClockFormatterFailed = false;
            wallClockCache.clear();
            lastSortSignature = null;
        }
    };
})();
`, app.context);

const perf = app.context.__perf;

// ---------------------------------------------------------------------------
// Benchmark harness. The 200 distinct strings and both parsers live in the vm
// so a pass is a single boundary crossing rather than 40,000 of them.
// ---------------------------------------------------------------------------
function timePass(useNaive, iterations) {
    const started = performance.now();
    const sink = perf.benchParse(iterations, useNaive);
    return { ms: performance.now() - started, sink: sink };
}

function aggregateBadge(statuses) {
    if (!statuses.length) return 'gray';
    const anyMissed = statuses.indexOf('missed') >= 0;
    const allChecked = statuses.every(status => status === 'checked');
    const anyPending = statuses.some(status => status === 'pending' || status === 'warning');
    if (anyMissed) return 'red';
    if (allChecked) return 'green';
    if (anyPending) return 'orange';
    return 'gray';
}

// ---------------------------------------------------------------------------
// parseWallClock memoisation
// ---------------------------------------------------------------------------

test('parseWallClock memo returns the exact original results', () => {
    const samples = [
        '2026-11-03T08:00',
        '2026-11-03T08:00',
        '2026-11-03T23:59:59',
        '2026-02-30T10:00',   // impossible calendar date
        '2026-13-01T10:00',   // impossible month
        'not-a-date',
        '',
        null,
        undefined
    ];
    for (const value of samples) {
        perf.resetPerfCaches(); // force a cold parse so the memo cannot mask a bug
        const cached = perf.parseWallClock(value);
        const naive = perf.naiveParseWallClock(value);
        if (naive === null) {
            assert.equal(cached, null, 'expected ' + JSON.stringify(value) + ' to stay invalid');
        } else {
            assert.ok(cached, 'expected ' + JSON.stringify(value) + ' to parse');
            assert.equal(cached.getTime(), naive.getTime(),
                'memorised timestamp differs for ' + JSON.stringify(value));
        }
    }

    // Repeated reads reuse the cached Date instance (callers only read it).
    perf.resetPerfCaches();
    const first = perf.parseWallClock('2026-11-03T08:00');
    const second = perf.parseWallClock('2026-11-03T08:00');
    assert.equal(second, first, 'memo hit should return the cached Date instance');
});

test('parseWallClock memo is at least 2x faster than the naive parser', () => {
    // Warm both implementations so the "best of 3" timing is stable.
    timePass(true, 5);
    perf.resetPerfCaches();
    timePass(false, 5);

    // 200 distinct strings x 200 iterations, best of 3.
    const ITERATIONS = 200;
    const RUNS = 3;
    let bestNaive = Infinity;
    let bestCached = Infinity;

    for (let run = 0; run < RUNS; run++) {
        // Cold cache per measured pass: every distinct string parses once,
        // then the remaining 39,800 lookups are memo hits.
        perf.resetPerfCaches();
        bestCached = Math.min(bestCached, timePass(false, ITERATIONS).ms);
        bestNaive = Math.min(bestNaive, timePass(true, ITERATIONS).ms);
    }

    const ratio = bestNaive / bestCached;
    console.log('  parseWallClock naive=' + bestNaive.toFixed(2) + 'ms cached=' +
        bestCached.toFixed(2) + 'ms ratio=' + ratio.toFixed(2) + 'x');
    assert.ok(ratio >= 2,
        'cached parseWallClock must be >=2x faster than naive, got ' + ratio.toFixed(2) +
        'x (naive ' + bestNaive.toFixed(2) + 'ms vs cached ' + bestCached.toFixed(2) + 'ms)');
});

// ---------------------------------------------------------------------------
// Cached Intl formatters
// ---------------------------------------------------------------------------

test('getCambodiaNow reuses a single Intl.DateTimeFormat instance', () => {
    perf.resetPerfCaches();
    vm.runInContext(`
        globalThis.__dtfCount = 0;
        globalThis.__origDTF = Intl.DateTimeFormat;
        Intl.DateTimeFormat = function (...args) {
            globalThis.__dtfCount++;
            return new globalThis.__origDTF(...args);
        };
        Intl.DateTimeFormat.prototype = globalThis.__origDTF.prototype;
    `, app.context);

    try {
        for (let i = 0; i < 100; i++) {
            const now = perf.getCambodiaNow();
            assert.equal(Object.prototype.toString.call(now), '[object Date]',
                'getCambodiaNow() must return a Date');
            assert.ok(isFinite(now.getTime()), 'getCambodiaNow() must return a valid Date');
        }

        const constructed = vm.runInContext('globalThis.__dtfCount', app.context);
        assert.equal(constructed, 1,
            'Intl.DateTimeFormat must be constructed exactly once across 100 getCambodiaNow() calls, got ' +
            constructed);

        const formatter = perf.getCambodiaNowFormatter();
        assert.ok(formatter, 'the cached formatter should be available');
        perf.getCambodiaNow();
        assert.equal(perf.getCambodiaNowFormatter(), formatter,
            'every getCambodiaNow() call must reuse the same formatter instance');
    } finally {
        vm.runInContext('Intl.DateTimeFormat = globalThis.__origDTF;', app.context);
        perf.resetPerfCaches();
    }
});

// ---------------------------------------------------------------------------
// Single-pass status computation
// ---------------------------------------------------------------------------

test('computeCardStatusSummary matches computeStatus and is stable across calls', () => {
    const fixedNow = new Date(2026, 10, 3, 10, 0, 0, 0);
    const task = {
        id: 'card-status',
        checklist: [
            { id: 'i-checked', start: '2026-11-03T08:00', end: '2026-11-03T09:00', status: 'checked', text: 'a' },
            { id: 'i-pending', start: '2026-11-03T09:30', end: '2026-11-03T11:00', status: 'unchecked', text: 'b' },
            { id: 'i-scheduled', start: '2026-11-03T12:00', end: '2026-11-03T13:00', status: 'unchecked', text: 'c' },
            { id: 'i-warning', start: '2026-11-03T09:00', end: '2026-11-03T09:15', status: 'warning', text: 'd' },
            { id: 'i-locked', start: '2026-11-03T07:00', end: '2026-11-03T07:30', status: 'missed', statusLocked: true, text: 'e' },
            { id: 'i-missed', start: '2026-11-03T07:00', end: '2026-11-03T07:30', status: 'unchecked', autoMissed: true, text: 'f' }
        ]
    };

    const expectedStatuses = task.checklist.map(item => perf.computeStatus(item, fixedNow));
    const expectedBadge = aggregateBadge(expectedStatuses);

    const first = perf.computeCardStatusSummary(task, fixedNow);
    const second = perf.computeCardStatusSummary(task, fixedNow);

    for (let i = 0; i < task.checklist.length; i++) {
        const id = task.checklist[i].id;
        assert.equal(first.statuses.get(id), expectedStatuses[i],
            'first pass status mismatch for ' + id);
        assert.equal(second.statuses.get(id), expectedStatuses[i],
            'second pass status mismatch for ' + id);
    }
    assert.equal(first.badgeType, expectedBadge, 'first pass badge mismatch');
    assert.equal(second.badgeType, expectedBadge, 'second pass badge mismatch');
    assert.equal(perf.computeCardBadge(task, fixedNow), expectedBadge,
        'public badge helper must agree with the single-pass summary');

    const checkedOnly = { checklist: [
        { id: 'c1', start: '2026-11-03T08:00', end: '2026-11-03T09:00', status: 'checked' },
        { id: 'c2', start: '2026-11-03T09:00', end: '2026-11-03T10:00', status: 'checked' }
    ] };
    assert.equal(perf.computeCardStatusSummary(checkedOnly, fixedNow).badgeType, 'green');

    const pendingOnly = { checklist: [
        { id: 'p1', start: '2026-11-03T09:30', end: '2026-11-03T11:00', status: 'unchecked' }
    ] };
    assert.equal(perf.computeCardStatusSummary(pendingOnly, fixedNow).badgeType, 'orange');

    assert.equal(perf.computeCardStatusSummary({ checklist: [] }, fixedNow).badgeType, 'gray');
});

// ---------------------------------------------------------------------------
// refreshStatuses hot path (real function, fake card/row objects)
// ---------------------------------------------------------------------------

function makeRow(itemId) {
    const classes = new Set();
    const box = { dataset: { status: '' }, className: '', innerText: '' };
    return {
        dataset: { itemId: itemId, status: '' },
        attrs: {},
        box: box,
        classList: {
            add(...names) { names.forEach(name => classes.add(String(name))); },
            remove(...names) { names.forEach(name => classes.delete(String(name))); },
            contains(name) { return classes.has(String(name)); }
        },
        hasAttribute(name) { return String(name) === 'aria-label'; },
        setAttribute(name, value) { this.attrs[String(name)] = value; },
        querySelector(selector) { return selector === '.custom-box' ? box : null; }
    };
}

function makeCard(task) {
    const rows = (task.checklist || []).map(item => makeRow(item.id));
    const badge = { dataset: { badge: '' }, className: '' };
    const dragBar = { style: { backgroundColor: '' } };
    return {
        dataset: { id: task.id },
        rows: rows,
        badge: badge,
        dragBar: dragBar,
        querySelectorAll(selector) {
            return selector === '.checklist-item[data-item-id]' ? rows : [];
        },
        querySelector(selector) {
            if (selector === '.badge-icon') return badge;
            if (selector === '.drag-bar') return dragBar;
            return null;
        }
    };
}

function snapshotCards(cards) {
    return cards.map(card => ({
        id: card.dataset.id,
        badge: card.badge.dataset.badge,
        badgeClass: card.badge.className,
        dragBar: card.dragBar.style.backgroundColor,
        rows: card.rows.map(row => ({
            id: row.dataset.itemId,
            status: row.dataset.status,
            boxStatus: row.box.dataset.status,
            boxClass: row.box.className
        }))
    }));
}

test('refreshStatuses applies correct statuses/badges on two consecutive ticks', () => {
    const fixedNow = new Date(2026, 10, 3, 10, 0, 0, 0);
    const refreshTasks = [
        {
            id: 'perf-card-red',
            checklist: [
                { id: 'perf-i-missed', start: '2026-11-03T08:00', end: '2026-11-03T09:00', status: 'unchecked', text: 'missed' },
                { id: 'perf-i-pending', start: '2026-11-03T09:30', end: '2026-11-03T11:00', status: 'unchecked', text: 'pending' }
            ]
        },
        {
            id: 'perf-card-green',
            checklist: [
                { id: 'perf-i-checked-a', start: '2026-11-03T08:00', end: '2026-11-03T09:00', status: 'checked', text: 'a' },
                { id: 'perf-i-checked-b', start: '2026-11-03T09:00', end: '2026-11-03T10:30', status: 'checked', text: 'b' }
            ]
        },
        { id: 'perf-card-empty', checklist: [] }
    ];
    const cards = refreshTasks.map(makeCard);

    const originalQuerySelectorAll = app.document.querySelectorAll;
    app.document.querySelectorAll = function (selector) {
        return selector === '.card' ? cards : [];
    };

    perf.setTasks(refreshTasks);
    perf.resetPerfCaches();
    perf.setNow(fixedNow.getTime());

    try {
        perf.refreshStatuses();

        const assertMatchesComputeStatus = (snapshot) => {
            for (let c = 0; c < refreshTasks.length; c++) {
                const task = refreshTasks[c];
                const cardState = snapshot[c];
                const statuses = task.checklist.map(item => perf.computeStatus(item, fixedNow));
                const expectedBadge = aggregateBadge(statuses);
                assert.equal(cardState.badge, expectedBadge,
                    'badge mismatch for ' + task.id);
                assert.equal(cardState.badgeClass, 'badge-icon badge-' + expectedBadge,
                    'badge class mismatch for ' + task.id);
                for (let i = 0; i < task.checklist.length; i++) {
                    const row = cardState.rows[i];
                    assert.equal(row.status, statuses[i],
                        'row status mismatch for ' + task.checklist[i].id);
                    assert.equal(row.boxStatus, statuses[i],
                        'checkbox status mismatch for ' + task.checklist[i].id);
                }
            }
        };

        const firstTick = snapshotCards(cards);
        assertMatchesComputeStatus(firstTick);

        perf.refreshStatuses();
        const secondTick = snapshotCards(cards);
        assert.deepEqual(secondTick, firstTick,
            'a second tick with unchanged data must leave every row and badge untouched');
        assertMatchesComputeStatus(secondTick);
    } finally {
        perf.restoreNow();
        perf.setTasks([]);
        app.document.querySelectorAll = originalQuerySelectorAll;
        perf.resetPerfCaches();
    }
});

// ---------------------------------------------------------------------------
// Redundant sort suppression
// ---------------------------------------------------------------------------

test('ensureSortOrder re-sorts only when the content signature changes', () => {
    const later = { id: 'b-card', checklist: [{ id: 'b1', start: '2026-11-03T12:00', end: '2026-11-03T12:15' }] };
    const earlier = { id: 'a-card', checklist: [{ id: 'a1', start: '2026-11-03T08:00', end: '2026-11-03T08:15' }] };

    perf.setTasks([later, earlier]);
    perf.resetPerfCaches(); // lastSortSignature = null forces the first sort

    try {
        perf.ensureSortOrder();
        const afterFirstSort = perf.getTasks();
        assert.deepEqual(afterFirstSort.map(task => task.id), ['a-card', 'b-card'],
            'first pass should order cards by earliest start');

        perf.ensureSortOrder();
        assert.equal(perf.getTasks(), afterFirstSort,
            'unchanged data must not trigger a second sort pass');

        // A start change must be detected by the signature and re-sort.
        earlier.checklist[0].start = '2026-11-03T20:00';
        perf.ensureSortOrder();
        const afterChange = perf.getTasks();
        assert.notEqual(afterChange, afterFirstSort,
            'a changed start must trigger a re-sort');
        assert.deepEqual(afterChange.map(task => task.id), ['b-card', 'a-card'],
            'cards should be re-ordered after the start change');
    } finally {
        perf.setTasks([]);
        perf.resetPerfCaches();
    }
});

process.on('exit', code => {
    console.log(code === 0 ? 'PERF: PASS' : 'PERF: FAIL (exit ' + code + ')');
});
