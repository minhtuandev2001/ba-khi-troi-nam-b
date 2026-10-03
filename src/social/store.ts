import {
  CHAT_PAGE_SIZE,
  FRIENDS_MAX,
  dmChannel,
  levelFromXp,
  type ChatChannel,
  type ChatMessage,
  type Relation,
  type SocialUser,
  type UserSearchResult,
} from '../shared';
import { pool } from '../db';

/** Social data access: friendships, chat messages, read markers and the admins' support inbox. */

interface UserCols {
  id: string;
  username: string;
  avatar: string;
  xp: number;
  role: string;
}

const toSocialUser = (r: UserCols): SocialUser => ({
  id: r.id, username: r.username, avatar: r.avatar, level: levelFromXp(r.xp), ...(r.role === 'admin' ? { admin: true } : {}),
});

const PAIR = '((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))';

export async function findSocialUserByName(username: string): Promise<SocialUser | null> {
  const { rows } = await pool.query<UserCols>('SELECT id, username, avatar, xp, role FROM users WHERE lower(username) = lower($1)', [username]);
  return rows[0] ? toSocialUser(rows[0]) : null;
}

/** `withMutes` adds each player's chat ban end (for admins). */
export async function searchUsers(me: string, query: string, withMutes = false, limit = 10): Promise<UserSearchResult[]> {
  const pattern = `${query.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await pool.query<UserCols & { requester_id: string | null; status: string | null; chat_muted_until: Date | null }>(
    `SELECT u.id, u.username, u.avatar, u.xp, u.role, u.chat_muted_until, f.requester_id, f.status
       FROM users u
       LEFT JOIN friendships f
         ON (f.requester_id = $1 AND f.addressee_id = u.id) OR (f.addressee_id = $1 AND f.requester_id = u.id)
      WHERE lower(u.username) LIKE $2 ESCAPE '\\' AND u.id <> $1
      ORDER BY length(u.username), lower(u.username)
      LIMIT $3`,
    [me, pattern, limit],
  );
  return rows.map((r) => {
    const relation: Relation = !r.status ? 'none' : r.status === 'accepted' ? 'friend' : r.requester_id === me ? 'outgoing' : 'incoming';
    const muted = withMutes && r.chat_muted_until && r.chat_muted_until.getTime() > Date.now();
    return { ...toSocialUser(r), relation, ...(muted ? { mutedUntil: r.chat_muted_until!.toISOString() } : {}) };
  });
}

/** When the player's chat ban ends, or null when they may chat. */
export async function chatMutedUntil(userId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ until: Date | null }>(
    'SELECT chat_muted_until AS until FROM users WHERE id = $1 AND chat_muted_until > now()',
    [userId],
  );
  return rows[0]?.until ?? null;
}

/** Bans the player from world chat and DMs for `minutes` (0 lifts the ban); null when the player is missing. */
export async function setChatMute(userId: string, minutes: number): Promise<{ username: string; until: Date | null } | null> {
  const { rows } = await pool.query<{ username: string; until: Date | null }>(
    `UPDATE users SET chat_muted_until = CASE WHEN $2::int > 0 THEN now() + make_interval(mins => $2::int) END
      WHERE id = $1 RETURNING username, chat_muted_until AS until`,
    [userId, minutes],
  );
  return rows[0] ?? null;
}

export interface FriendRows {
  friends: SocialUser[];
  incoming: SocialUser[];
  outgoing: SocialUser[];
}

export async function listFriendships(me: string): Promise<FriendRows> {
  const { rows } = await pool.query<UserCols & { status: string; outgoing: boolean }>(
    `SELECT u.id, u.username, u.avatar, u.xp, u.role, f.status, f.requester_id = $1 AS outgoing
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
      WHERE f.requester_id = $1 OR f.addressee_id = $1
      ORDER BY lower(u.username)`,
    [me],
  );
  const out: FriendRows = { friends: [], incoming: [], outgoing: [] };
  for (const r of rows) {
    const list = r.status === 'accepted' ? out.friends : r.outgoing ? out.outgoing : out.incoming;
    list.push(toSocialUser(r));
  }
  return out;
}

export async function friendIds(me: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS id
       FROM friendships WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'`,
    [me],
  );
  return rows.map((r) => r.id);
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM friendships WHERE ${PAIR} AND status = 'accepted'`, [a, b]);
  return rows.length > 0;
}

export type RequestOutcome = 'sent' | 'accepted' | 'already_friends' | 'already_sent' | 'limit';

/** Sends a request, or accepts the target's pending request to us when there is one. */
export async function requestFriend(me: string, target: string): Promise<RequestOutcome> {
  const { rows } = await pool.query<{ requester_id: string; status: string }>(
    `SELECT requester_id, status FROM friendships WHERE ${PAIR}`,
    [me, target],
  );
  const existing = rows[0];
  if (existing?.status === 'accepted') return 'already_friends';
  if (existing?.requester_id === me) return 'already_sent';
  if (existing) {
    await pool.query(`UPDATE friendships SET status = 'accepted' WHERE requester_id = $2 AND addressee_id = $1`, [me, target]);
    return 'accepted';
  }
  const { rows: count } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM friendships WHERE requester_id = $1 OR (addressee_id = $1 AND status = 'accepted')`,
    [me],
  );
  if (count[0].n >= FRIENDS_MAX) return 'limit';
  try {
    await pool.query('INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2)', [me, target]);
  } catch (err) {
    // the other side sent theirs at the same moment
    if ((err as { code?: string }).code === '23505') return requestFriend(me, target);
    throw err;
  }
  return 'sent';
}

/** Accepts or declines a pending request from `requester`; false when there is no such request. */
export async function respondFriend(me: string, requester: string, accept: boolean): Promise<boolean> {
  const sql = accept
    ? `UPDATE friendships SET status = 'accepted' WHERE requester_id = $2 AND addressee_id = $1 AND status = 'pending'`
    : `DELETE FROM friendships WHERE requester_id = $2 AND addressee_id = $1 AND status = 'pending'`;
  const { rowCount } = await pool.query(sql, [me, requester]);
  return (rowCount ?? 0) > 0;
}

/** Unfriends, cancels our request or declines theirs, whichever exists. */
export async function removeFriendship(me: string, other: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM friendships WHERE ${PAIR}`, [me, other]);
  return (rowCount ?? 0) > 0;
}

export async function insertMessage(channel: ChatChannel, from: SocialUser, text: string): Promise<ChatMessage> {
  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    'INSERT INTO chat_messages (channel, sender_id, body) VALUES ($1, $2, $3) RETURNING id::text, created_at',
    [channel, from.id, text],
  );
  return { id: rows[0].id, channel, from, text, at: rows[0].created_at.toISOString() };
}

/** Newest page of a channel (or the page before message `before`), oldest first. */
export async function channelHistory(channel: ChatChannel, before: string | null, limit = CHAT_PAGE_SIZE): Promise<ChatMessage[]> {
  const { rows } = await pool.query<UserCols & { msg_id: string; body: string; created_at: Date }>(
    `SELECT m.id::text AS msg_id, m.body, m.created_at, u.id, u.username, u.avatar, u.xp, u.role
       FROM chat_messages m JOIN users u ON u.id = m.sender_id
      WHERE m.channel = $1 AND ($2::bigint IS NULL OR m.id < $2::bigint)
      ORDER BY m.id DESC
      LIMIT $3`,
    [channel, before, limit],
  );
  return rows.reverse().map((r) => ({ id: r.msg_id, channel, from: toSocialUser(r), text: r.body, at: r.created_at.toISOString() }));
}

export async function markRead(me: string, channel: ChatChannel, messageId: string): Promise<void> {
  await pool.query(
    `INSERT INTO chat_reads (user_id, channel, last_read_id) VALUES ($1, $2, $3::bigint)
     ON CONFLICT (user_id, channel) DO UPDATE SET last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id)`,
    [me, channel, messageId],
  );
}

/** Messages in a channel from anyone but `me`, newer than what `me` has read. */
export async function unreadIn(me: string, channel: ChatChannel): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM chat_messages m
       LEFT JOIN chat_reads r ON r.user_id = $1 AND r.channel = m.channel
      WHERE m.channel = $2 AND m.sender_id <> $1 AND m.id > coalesce(r.last_read_id, 0)`,
    [me, channel],
  );
  return rows[0].n;
}

export interface SupportThreadRow {
  user: SocialUser;
  last: { text: string; at: string; fromAdmin: boolean };
  unread: number;
}

/** Support threads with their latest message, newest first; unread counts the player's messages `admin` has not read. */
export async function supportInbox(admin: string, limit = 100): Promise<SupportThreadRow[]> {
  const { rows } = await pool.query<UserCols & { body: string; created_at: Date; sender_id: string; unread: number }>(
    `WITH last AS (
       SELECT DISTINCT ON (channel) channel, id, body, created_at, sender_id
         FROM chat_messages WHERE channel LIKE 'support:%'
        ORDER BY channel, id DESC
     )
     SELECT l.body, l.created_at, l.sender_id, u.id, u.username, u.avatar, u.xp, u.role,
            (SELECT count(*)::int FROM chat_messages m
              WHERE m.channel = l.channel AND m.sender_id = u.id
                AND m.id > coalesce((SELECT r.last_read_id FROM chat_reads r WHERE r.user_id = $1 AND r.channel = l.channel), 0)
            ) AS unread
       FROM last l
       JOIN users u ON u.id::text = substring(l.channel FROM 9)
      ORDER BY l.id DESC
      LIMIT $2`,
    [admin, limit],
  );
  return rows.map((r) => ({
    user: toSocialUser(r),
    last: { text: r.body, at: r.created_at.toISOString(), fromAdmin: r.sender_id !== r.id },
    unread: r.unread,
  }));
}

/** Unread DM counts keyed by friend id. */
export async function unreadByFriend(me: string, friends: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!friends.length) return result;
  const channels = friends.map((f) => dmChannel(me, f));
  const { rows } = await pool.query<{ channel: string; n: number }>(
    `SELECT m.channel, count(*)::int AS n
       FROM chat_messages m
       LEFT JOIN chat_reads r ON r.user_id = $1 AND r.channel = m.channel
      WHERE m.channel = ANY($2::text[]) AND m.sender_id <> $1 AND m.id > coalesce(r.last_read_id, 0)
      GROUP BY m.channel`,
    [me, channels],
  );
  const byChannel = new Map(rows.map((r) => [r.channel, r.n]));
  for (const f of friends) result.set(f, byChannel.get(dmChannel(me, f)) ?? 0);
  return result;
}