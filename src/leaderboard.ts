import { LEADERBOARD_MIN_MATCHES, LEADERBOARD_SIZE, type LeaderboardKind, type RankBoard, type RankEntry } from './shared';
import { getStats, rankPlayers } from './db';

/** Ranking every player is one query over all match rows; boards are rebuilt at most this often. */
const CACHE_MS = 30_000;

interface Cached {
  ranked: RankEntry[];
  byId: Map<string, RankEntry>;
}

const cache = new Map<LeaderboardKind, Promise<Cached>>();
const builtAt = new Map<LeaderboardKind, number>();

function board(kind: LeaderboardKind): Promise<Cached> {
  const hit = cache.get(kind);
  if (hit && Date.now() - (builtAt.get(kind) ?? 0) < CACHE_MS) return hit;
  // concurrent requests share one rebuild; a failed one is dropped so the next request tries again
  const next = rankPlayers(kind).then((ranked) => ({ ranked, byId: new Map(ranked.map((e) => [e.id, e])) }));
  cache.set(kind, next);
  builtAt.set(kind, Date.now());
  next.catch(() => {
    if (cache.get(kind) === next) cache.delete(kind);
  });
  return next;
}

/** Drops the cached boards, so a deleted account leaves them at once. */
export function forgetLeaderboard(): void {
  cache.clear();
  builtAt.clear();
}

export async function getLeaderboard(kind: LeaderboardKind, userId: string): Promise<RankBoard> {
  const { ranked, byId } = await board(kind);
  const me = byId.get(userId) ?? null;
  return {
    kind,
    entries: ranked.slice(0, LEADERBOARD_SIZE),
    me,
    myMatches: me ? me.matches : (await getStats(userId)).matches,
    minMatches: LEADERBOARD_MIN_MATCHES,
  };
}
