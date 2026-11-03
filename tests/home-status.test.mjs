// Unit tests for the achieved-card ("Home archive") helpers, the archive
// fields carried through imports, and merge fidelity for those fields.
// Run with: node --test tests/home-status.test.mjs
//
// The app script runs in a node:vm context (see ./lib/load-app.mjs), so these
// tests exercise the real source without a browser, network or filesystem.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { loadApp } from './lib/load-app.mjs';

const { api, context } = loadApp();

// mergeTasks is an internal (not part of the exported contract). The loader
// returns the vm context, and the app declares its helpers at script top
// level, so a follow-up run inside that same context can reach it directly.
const mergeTasks = vm.runInContext('mergeTasks', context);

const ISO_EARLY = '2024-01-01T00:00:00.000Z';
const ISO_MID = '2024-02-01T00:00:00.000Z';
const ISO_LATE = '2024-03-01T00:00:00.000Z';

function card(overrides) {
    return Object.assign({
        id: 'card-a',
        title: 'Card A',
        description: '',
        coverUrl: '',
        expanded: true,
        starred: false,
        badge: 'gray',
        status: false,
        outcome: null,
        achievedAt: null,
        checklist: [],
        detailPoints: [],
        updatedAt: ISO_EARLY
    }, overrides);
}

function ids(cards) {
    return cards.map(card => card.id);
}

// ---------- isAchievedCard ----------

test('isAchievedCard is true only for status === true', () => {
    assert.equal(api.isAchievedCard({ status: true }), true);
    assert.equal(api.isAchievedCard({ status: false }), false);
    assert.equal(api.isAchievedCard({}), false);
    assert.equal(api.isAchievedCard({ status: 'true' }), false);
    assert.equal(api.isAchievedCard({ status: 1 }), false);
    assert.equal(api.isAchievedCard({ status: null }), false);
    assert.equal(api.isAchievedCard(null), false);
    assert.equal(api.isAchievedCard(undefined), false);
    assert.equal(api.isAchievedCard('card'), false);
    assert.equal(api.isAchievedCard(42), false);
});

// ---------- achievedOutcomeOf ----------

test('achievedOutcomeOf defaults to succeeded and only accepts exactly "failed"', () => {
    assert.equal(api.achievedOutcomeOf({ outcome: 'failed' }), 'failed');
    assert.equal(api.achievedOutcomeOf({ outcome: 'succeeded' }), 'succeeded');
    assert.equal(api.achievedOutcomeOf({}), 'succeeded');
    assert.equal(api.achievedOutcomeOf({ outcome: 'FAILED' }), 'succeeded');
    assert.equal(api.achievedOutcomeOf({ outcome: 'Failed' }), 'succeeded');
    assert.equal(api.achievedOutcomeOf({ outcome: '' }), 'succeeded');
    assert.equal(api.achievedOutcomeOf({ outcome: undefined }), 'succeeded');
    assert.equal(api.achievedOutcomeOf({ outcome: null }), 'succeeded');
    assert.doesNotThrow(() => api.achievedOutcomeOf(null));
    assert.equal(api.achievedOutcomeOf(null), 'succeeded');
});

// ---------- applyAchievedState ----------

test('applyAchievedState archives a clean card, defaulting outcome and stamping both timestamps', () => {
    const source = card({ id: 'card-clean' });
    const archived = api.applyAchievedState(source, true, ISO_MID);

    assert.equal(archived.status, true);
    assert.equal(archived.outcome, 'succeeded');
    assert.equal(archived.achievedAt, ISO_MID);
    assert.equal(archived.updatedAt, ISO_MID, 'archive must stamp updatedAt so merges see the change');
});

test('applyAchievedState preserves an existing valid outcome', () => {
    const failed = api.applyAchievedState(card({ outcome: 'failed' }), true, ISO_MID);
    assert.equal(failed.outcome, 'failed');

    const succeeded = api.applyAchievedState(card({ outcome: 'succeeded' }), true, ISO_MID);
    assert.equal(succeeded.outcome, 'succeeded');
});

test('applyAchievedState replaces an invalid outcome with succeeded', () => {
    for (const outcome of ['bogus', '', null, undefined, 'FAILED', 1]) {
        const next = api.applyAchievedState(card({ outcome }), true, ISO_MID);
        assert.equal(next.outcome, 'succeeded', `outcome ${JSON.stringify(outcome)} should default`);
    }
});

test('applyAchievedState restore clears archive fields and stamps updatedAt', () => {
    const source = card({ status: true, outcome: 'failed', achievedAt: ISO_MID });
    const restored = api.applyAchievedState(source, false, ISO_LATE);

    assert.equal(restored.status, false);
    assert.equal(restored.outcome, null);
    assert.equal(restored.achievedAt, null);
    assert.equal(typeof restored.updatedAt, 'string');
    assert.ok(isFinite(Date.parse(restored.updatedAt)), 'restore must write a valid ISO updatedAt');
});

test('applyAchievedState never mutates the input card', () => {
    const source = card({ id: 'card-stable', status: true, outcome: 'failed', achievedAt: ISO_MID });
    const snapshot = JSON.parse(JSON.stringify(source));

    api.applyAchievedState(source, false, ISO_LATE);
    api.applyAchievedState(source, true, ISO_LATE);

    assert.deepEqual(source, snapshot);
});

test('applyAchievedState generates a valid ISO stamp when atIso is missing', () => {
    const archived = api.applyAchievedState(card(), true);
    assert.equal(typeof archived.achievedAt, 'string');
    assert.ok(isFinite(Date.parse(archived.achievedAt)));
    assert.equal(archived.updatedAt, archived.achievedAt, 'both fields share the generated stamp');
});

// ---------- filterHomeCards ----------

test('filterHomeCards active excludes achieved cards, keeps input order and returns a new array', () => {
    const cards = [
        card({ id: 'a1' }),
        card({ id: 'arch', status: true, achievedAt: ISO_LATE }),
        card({ id: 'a2' }),
        card({ id: 'a3' })
    ];
    const result = api.filterHomeCards(cards, 'active', 'all');

    assert.notEqual(result, cards, 'must return a new array');
    assert.deepEqual(ids(result), ['a1', 'a2', 'a3']);
});

test('filterHomeCards achieved view includes only achieved cards', () => {
    const cards = [
        card({ id: 'a1' }),
        card({ id: 'arch1', status: true, achievedAt: ISO_MID }),
        card({ id: 'arch2', status: true, achievedAt: ISO_LATE })
    ];
    assert.deepEqual(ids(api.filterHomeCards(cards, 'achieved', 'all')).sort(), ['arch1', 'arch2']);
});

test('filterHomeCards outcome filters select the right subsets and unknown filters fall back to all', () => {
    const cards = [
        card({ id: 's1', status: true, outcome: 'succeeded', achievedAt: ISO_EARLY }),
        card({ id: 'f1', status: true, outcome: 'failed', achievedAt: ISO_MID }),
        card({ id: 's2', status: true, outcome: 'succeeded', achievedAt: ISO_LATE }),
        card({ id: 'active', status: false })
    ];

    assert.deepEqual(ids(api.filterHomeCards(cards, 'achieved', 'succeeded')), ['s2', 's1']);
    assert.deepEqual(ids(api.filterHomeCards(cards, 'achieved', 'failed')), ['f1']);
    // An achieved card with a non-standard outcome is treated as succeeded.
    assert.deepEqual(ids(api.filterHomeCards(cards, 'achieved', 'bogus')).sort(), ['f1', 's1', 's2']);
});

test('filterHomeCards sorts by achievedAt desc, then updatedAt desc, then id', () => {
    const cards = [
        card({ id: 'b', status: true, achievedAt: ISO_MID, updatedAt: ISO_EARLY }),
        card({ id: 'a', status: true, achievedAt: ISO_MID, updatedAt: ISO_EARLY }),
        card({ id: 'newest', status: true, achievedAt: ISO_LATE, updatedAt: ISO_EARLY }),
        card({ id: 'recent', status: true, achievedAt: ISO_MID, updatedAt: ISO_LATE }),
        card({ id: 'oldest', status: true, achievedAt: ISO_EARLY, updatedAt: ISO_LATE })
    ];

    const expected = ['newest', 'recent', 'a', 'b', 'oldest'];
    assert.deepEqual(ids(api.filterHomeCards(cards, 'achieved', 'all')), expected);

    // Shuffled input must produce exactly the same projection.
    const shuffled = [cards[3], cards[0], cards[4], cards[2], cards[1]];
    assert.deepEqual(ids(api.filterHomeCards(shuffled, 'achieved', 'all')), expected);
});

test('filterHomeCards never mutates the input array or cards and returns the same references', () => {
    const cards = [
        card({ id: 'x', status: true, achievedAt: ISO_LATE }),
        card({ id: 'y', status: true, achievedAt: ISO_EARLY }),
        card({ id: 'z' })
    ];
    const snapshot = JSON.parse(JSON.stringify(cards));
    const activeResult = api.filterHomeCards(cards, 'active', 'all');
    const achievedResult = api.filterHomeCards(cards, 'achieved', 'all');

    assert.deepEqual(cards, snapshot, 'input array and card objects must be untouched');
    assert.equal(activeResult[0], cards[2], 'returns the same card references');
    assert.equal(achievedResult[0], cards[0]);
    assert.equal(achievedResult[1], cards[1]);
});

test('filterHomeCards handles non-array input and cards without ids', () => {
    for (const bad of [null, undefined, {}, 'cards', 7]) {
        assert.equal(api.filterHomeCards(bad, 'achieved', 'all').length, 0);
        assert.equal(api.filterHomeCards(bad, 'active', 'all').length, 0);
    }

    const result = api.filterHomeCards([
        { status: true, achievedAt: ISO_LATE },
        { status: true, achievedAt: ISO_EARLY }
    ], 'achieved', 'all');
    assert.equal(result.length, 2);
});

// ---------- sanitizeImportedTask archive fields ----------

test('sanitizeImportedTask preserves valid archive fields', () => {
    const clean = api.sanitizeImportedTask({
        id: 'card-ok',
        title: 'Done',
        status: true,
        outcome: 'failed',
        achievedAt: '2024-01-02T03:04:05.000Z'
    });

    assert.equal(clean.status, true);
    assert.equal(clean.outcome, 'failed');
    assert.equal(clean.achievedAt, '2024-01-02T03:04:05.000Z');
});

test('sanitizeImportedTask coerces status to false unless it is strictly true', () => {
    for (const status of [false, 'true', 1, 'yes', null, undefined, {}]) {
        const clean = api.sanitizeImportedTask({ id: 'card-x', status });
        assert.equal(clean.status, false, `status ${JSON.stringify(status)} must coerce to false`);
    }
});

test('sanitizeImportedTask whitelists outcome and clears it on active cards', () => {
    assert.equal(api.sanitizeImportedTask({ status: true, outcome: 'succeeded' }).outcome, 'succeeded');
    assert.equal(api.sanitizeImportedTask({ status: true, outcome: 'failed' }).outcome, 'failed');
    // Unlike applyAchievedState, an achieved card with an unknown outcome is
    // cleared rather than defaulted: imports never invent an outcome.
    assert.equal(api.sanitizeImportedTask({ status: true, outcome: 'bogus' }).outcome, null);
    assert.equal(api.sanitizeImportedTask({ status: true, outcome: 'FAILED' }).outcome, null);
    assert.equal(api.sanitizeImportedTask({ status: false, outcome: 'failed' }).outcome, null);
});

test('sanitizeImportedTask rejects invalid achievedAt and clears it on active cards', () => {
    assert.equal(api.sanitizeImportedTask({ status: true, achievedAt: 'not-a-date' }).achievedAt, null);
    assert.equal(api.sanitizeImportedTask({ status: true, achievedAt: '' }).achievedAt, null);
    assert.equal(api.sanitizeImportedTask({ status: true, achievedAt: 12345 }).achievedAt, null);
    assert.equal(
        api.sanitizeImportedTask({ status: true, achievedAt: '2024-05-06T07:08:09Z' }).achievedAt,
        '2024-05-06T07:08:09.000Z'
    );
    assert.equal(
        api.sanitizeImportedTask({ status: false, achievedAt: '2024-05-06T07:08:09.000Z' }).achievedAt,
        null
    );
});

test('sanitizeImportedTask keeps non-archive fields intact', () => {
    const clean = api.sanitizeImportedTask({
        id: 'Card 1',
        title: 'Title',
        description: 'Description',
        coverUrl: 'https://example.com/a.png',
        expanded: false,
        starred: true,
        badge: 'green',
        detailPoints: ['keep', 42, { drop: true }],
        checklist: [{ id: 'c1', text: 'item', status: 'checked' }]
    });

    assert.equal(typeof clean.id, 'string');
    assert.equal(clean.title, 'Title');
    assert.equal(clean.description, 'Description');
    assert.equal(clean.coverUrl, 'https://example.com/a.png');
    assert.equal(clean.expanded, false);
    assert.equal(clean.starred, true);
    assert.equal(clean.badge, 'green');
    assert.deepEqual(clean.detailPoints, ['keep']);
    assert.equal(clean.checklist.length, 1);
    assert.equal(clean.checklist[0].text, 'item');
    assert.equal(clean.checklist[0].status, 'checked');
});

// ---------- MERGE_CARD_FIELDS ----------

test('MERGE_CARD_FIELDS carries archive state alongside the original fields', () => {
    // Array.from: MERGE_CARD_FIELDS lives in the vm realm, whose Array
    // prototype differs from this file's.
    const fields = Array.from(api.MERGE_CARD_FIELDS);
    assert.deepEqual(fields, [
        'title', 'description', 'coverUrl', 'expanded', 'starred', 'badge',
        'status', 'outcome', 'achievedAt'
    ]);
    for (const field of ['title', 'description', 'coverUrl', 'expanded', 'starred', 'badge', 'status', 'outcome', 'achievedAt']) {
        assert.ok(fields.includes(field), `missing ${field}`);
    }
});

// ---------- merge fidelity through mergeTasks ----------

test('merge: local active + newer remote archived becomes archived with its outcome', () => {
    const local = card({ id: 'card-1', updatedAt: ISO_EARLY });
    const remote = card({
        id: 'card-1',
        status: true,
        outcome: 'failed',
        achievedAt: ISO_MID,
        updatedAt: ISO_MID
    });

    const merged = mergeTasks([local], [remote]).tasks;
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, true);
    assert.equal(merged[0].outcome, 'failed');
    assert.equal(merged[0].achievedAt, ISO_MID);
    assert.equal(merged[0].updatedAt, ISO_MID);
});

test('merge: newer local archived + older remote active stays archived', () => {
    const local = card({
        id: 'card-1',
        status: true,
        outcome: 'succeeded',
        achievedAt: ISO_LATE,
        updatedAt: ISO_LATE
    });
    const remote = card({ id: 'card-1', updatedAt: ISO_EARLY });

    const merged = mergeTasks([local], [remote]).tasks[0];
    assert.equal(merged.status, true);
    assert.equal(merged.outcome, 'succeeded');
    assert.equal(merged.achievedAt, ISO_LATE);
    assert.equal(merged.updatedAt, ISO_LATE);
});

test('merge: newer local active + older remote archived stays active with no outcome', () => {
    const local = card({ id: 'card-1', updatedAt: ISO_LATE });
    const remote = card({
        id: 'card-1',
        status: true,
        outcome: 'failed',
        achievedAt: ISO_EARLY,
        updatedAt: ISO_EARLY
    });

    const merged = mergeTasks([local], [remote]).tasks[0];
    assert.equal(merged.status, false);
    assert.equal(merged.outcome, null);
    assert.equal(merged.achievedAt, null);
    assert.equal(merged.updatedAt, ISO_LATE);
});

test('merge: a card only in the remote keeps its archive fields when added', () => {
    const local = card({ id: 'card-local' });
    const remote = card({
        id: 'card-remote',
        status: true,
        outcome: 'failed',
        achievedAt: ISO_LATE,
        updatedAt: ISO_LATE
    });

    const merged = mergeTasks([local], [remote]).tasks;
    const added = merged.find(t => t.id === 'card-remote');
    assert.ok(added, 'remote-only card must be added');
    assert.equal(added.status, true);
    assert.equal(added.outcome, 'failed');
    assert.equal(added.achievedAt, ISO_LATE);
    assert.equal(added.updatedAt, ISO_LATE);
});

// v7: card-merges treat status/outcome/achievedAt as tri-state. Absent on
// the winning side means "not archived", never "inherit the loser". The old
// fallback silently archived a newer active card (or blocked a restore) when
// a hand-built or legacy payload omitted the archive keys.
test('merge: an absent archive field means active, never inherit the loser', () => {
    const localWithoutOutcome = {
        id: 'card-1',
        title: 'Local',
        checklist: [],
        detailPoints: [],
        status: false,
        achievedAt: null,
        updatedAt: ISO_LATE
    };
    const remote = card({
        id: 'card-1',
        status: true,
        outcome: 'failed',
        achievedAt: ISO_EARLY,
        updatedAt: ISO_EARLY
    });

    const merged = mergeTasks([localWithoutOutcome], [remote]).tasks[0];
    assert.equal(merged.status, false, 'status is present on the winner');
    assert.equal(merged.outcome, null, 'absent outcome must resolve neutral, not inherit "failed"');
    assert.equal(merged.achievedAt, null);
});

test('merge: a newer active card with no archive keys is never archived by an older archived loser', () => {
    // The silent-archiving bug v7 fixed: the winner carries none of the
    // archive keys at all, so the loser's status/outcome must not leak in.
    const bareActive = {
        id: 'card-1',
        title: 'Local',
        checklist: [],
        detailPoints: [],
        updatedAt: ISO_LATE
    };
    const remoteArchived = card({
        id: 'card-1',
        status: true,
        outcome: 'failed',
        achievedAt: ISO_EARLY,
        updatedAt: ISO_EARLY
    });

    const merged = mergeTasks([bareActive], [remoteArchived]).tasks[0];
    assert.equal(merged.status, false);
    assert.equal(merged.outcome, null);
    assert.equal(merged.achievedAt, null);
});
