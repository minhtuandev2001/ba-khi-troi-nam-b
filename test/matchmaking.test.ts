/** Unit tests for how queue tickets become teams and matches; no server or database needed. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fitSlots, formTeams, freeSlot, packMatch, roomTeams, type QueueTicket } from '../src/game/matchmaking';

let seq = 0;
function ticket(size: number, fill = true, joinedAt = ++seq): QueueTicket {
  const id = `t${joinedAt}`;
  return { id, userIds: Array.from({ length: size }, (_, i) => `${id}u${i}`), fill, joinedAt };
}
const sizes = (teams: QueueTicket[][]) => teams.map((t) => t.reduce((n, x) => n + x.userIds.length, 0));

describe('formTeams', () => {
  test('solo: every ticket is its own team', () => {
    const teams = formTeams([ticket(1), ticket(1), ticket(1)], 1);
    assert.deepEqual(sizes(teams), [1, 1, 1]);
  });

  test('fill tickets are merged first-fit, oldest first', () => {
    const [a, b, c, d] = [ticket(1), ticket(2), ticket(1), ticket(3)];
    const teams = formTeams([d, c, b, a], 4);
    // a(1)+b(2)+c(1) fill the first squad; d(3) opens a second one
    assert.deepEqual(teams.map((t) => t.map((x) => x.id)), [[a.id, b.id, c.id], [d.id]]);
  });

  test('a party that refuses strangers stays alone even if not full', () => {
    const lone = ticket(2, false);
    const teams = formTeams([lone, ticket(1), ticket(1)], 4);
    assert.deepEqual(sizes(teams), [2, 2]);
    assert.deepEqual(teams[0], [lone]);
  });

  test('full parties are never merged', () => {
    assert.deepEqual(sizes(formTeams([ticket(2), ticket(2), ticket(1)], 2)), [2, 2, 1]);
  });
});

describe('packMatch', () => {
  test('waits until the match is full', () => {
    assert.equal(packMatch([ticket(1), ticket(1)], 1, 3), null);
    assert.equal(packMatch(Array.from({ length: 99 }, () => ticket(1)), 1, 100), null);
    assert.equal(packMatch(Array.from({ length: 100 }, () => ticket(1)), 1, 100)?.length, 100);
  });

  test('squads start once no further full squad fits', () => {
    const squads = Array.from({ length: 24 }, () => ticket(4));
    assert.equal(packMatch(squads, 4, 100), null);
    // 96 + 1 strangers in a fill team = 97 = capacity - teamSize + 1
    const teams = packMatch([...squads, ticket(1)], 4, 100);
    assert.ok(teams);
    assert.equal(sizes(teams).reduce((a, b) => a + b, 0), 97);
  });

  test('never exceeds capacity and never splits a ticket', () => {
    const queue = [...Array.from({ length: 30 }, () => ticket(4)), ticket(3, false), ticket(2)];
    const teams = packMatch(queue, 4, 100)!;
    const total = sizes(teams).reduce((a, b) => a + b, 0);
    assert.equal(total, 100);
    const ids = teams.flat().map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('a ticket too big for the space left is skipped, younger ones fit', () => {
    const squads = Array.from({ length: 24 }, () => ticket(4));
    const trio = ticket(3, false);
    const late = ticket(4);
    const solo = ticket(1, false);
    // 96 + 3 = 99: the next squad would overflow, the lone player behind it fills the last slot
    const teams = packMatch([...squads, trio, late, solo], 4, 100)!;
    const ids = teams.flat().map((t) => t.id);
    assert.ok(!ids.includes(late.id));
    assert.ok(ids.includes(solo.id));
    assert.equal(sizes(teams).reduce((a, b) => a + b, 0), 100);
  });
});

describe('private-room slots', () => {
  test('freeSlot takes the lowest empty slot, -1 when full', () => {
    assert.equal(freeSlot(new Map([['a', 0], ['b', 2]]), 4), 1);
    assert.equal(freeSlot(new Map([['a', 0], ['b', 1]]), 2), -1);
  });

  test('fitSlots moves members off slots a smaller map lacks, others stay put', () => {
    const slots = new Map([['a', 3], ['b', 60], ['c', 0], ['d', 55]]);
    fitSlots(slots, 50);
    assert.deepEqual(Object.fromEntries(slots), { a: 3, c: 0, d: 1, b: 2 });
  });

  test('roomTeams groups slots by team size and numbers teams in order, skipping empty ones', () => {
    const slots = new Map([['a', 0], ['b', 1], ['c', 5], ['d', 9]]);
    assert.deepEqual(Object.fromEntries(roomTeams(slots, 2)), { a: 0, b: 0, c: 1, d: 2 });
    // switching to squads keeps every slot: 0,1 → team 0, 5 → team 1 (slots 4-7), 9 → team 2 (slots 8-11)
    assert.deepEqual(Object.fromEntries(roomTeams(slots, 4)), { a: 0, b: 0, c: 1, d: 2 });
    assert.deepEqual(Object.fromEntries(roomTeams(new Map([['a', 0], ['b', 3]]), 4)), { a: 0, b: 0 });
    assert.deepEqual(Object.fromEntries(roomTeams(new Map([['a', 0], ['b', 3]]), 2)), { a: 0, b: 1 });
  });
});
