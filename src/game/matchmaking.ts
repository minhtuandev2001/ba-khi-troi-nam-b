/** A solo player or a party waiting in one team-size queue; a ticket is never split across teams. */
export interface QueueTicket {
  id: string;
  userIds: string[];
  /** Whether random players may join to complete the team. */
  fill: boolean;
  joinedAt: number;
}

/**
 * Groups tickets into teams, oldest first. A ticket that is already full, or that refuses strangers,
 * is a team on its own; the others are merged first-fit into teams of up to `teamSize`.
 */
export function formTeams<T extends QueueTicket>(tickets: readonly T[], teamSize: number): T[][] {
  const teams: T[][] = [];
  const open: { team: T[]; size: number }[] = [];
  for (const t of [...tickets].sort((a, b) => a.joinedAt - b.joinedAt)) {
    const n = t.userIds.length;
    if (n >= teamSize || !t.fill) {
      teams.push([t]);
      continue;
    }
    const slot = open.find((o) => o.size + n <= teamSize);
    if (slot) {
      slot.team.push(t);
      slot.size += n;
      if (slot.size === teamSize) open.splice(open.indexOf(slot), 1);
    } else {
      const team = [t];
      teams.push(team);
      open.push({ team, size: n });
    }
  }
  // order teams by their oldest ticket so long waits are served first
  return teams.sort((a, b) => a[0].joinedAt - b[0].joinedAt);
}

/**
 * Picks the teams for one match, or null while there are too few players. A match starts once
 * no further full team could fit, so squads are not left waiting for one last slot.
 */
export function packMatch<T extends QueueTicket>(tickets: readonly T[], teamSize: number, capacity: number): T[][] | null {
  const picked: T[][] = [];
  let players = 0;
  for (const team of formTeams(tickets, teamSize)) {
    const n = team.reduce((s, t) => s + t.userIds.length, 0);
    if (players + n > capacity) continue;
    picked.push(team);
    players += n;
    if (players === capacity) break;
  }
  return players >= capacity - teamSize + 1 ? picked : null;
}

// ---------------------------------------------------------------- private-room slots
// Room members sit in numbered slots; slot k belongs to team floor(k / teamSize), so switching
// team size keeps everyone in place and only regroups the slots.

/** Lowest slot below `capacity` that nobody sits in, or -1 when the room is full. */
export function freeSlot(slots: ReadonlyMap<string, number>, capacity: number): number {
  const taken = new Set(slots.values());
  for (let i = 0; i < capacity; i++) if (!taken.has(i)) return i;
  return -1;
}

/** Moves members whose slot no longer exists (a smaller map) into the lowest free slots. */
export function fitSlots(slots: Map<string, number>, capacity: number) {
  for (const [id, slot] of [...slots].sort((a, b) => a[1] - b[1])) {
    if (slot < capacity) continue;
    slots.delete(id);
    slots.set(id, freeSlot(slots, capacity));
  }
}

/** Team of every member for a match, numbered 0..n-1 in slot order; empty teams are skipped. */
export function roomTeams(slots: ReadonlyMap<string, number>, teamSize: number): Map<string, number> {
  const groups = [...new Set([...slots.values()].map((s) => Math.floor(s / teamSize)))].sort((a, b) => a - b);
  const index = new Map(groups.map((g, i) => [g, i]));
  return new Map([...slots].map(([id, s]) => [id, index.get(Math.floor(s / teamSize))!]));
}
