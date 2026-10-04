/** Chat channels are plain strings so new kinds (room, clan, match…) only need a new prefix. */
export const WORLD_CHANNEL = 'world';
export type ChatChannel = typeof WORLD_CHANNEL | `dm:${string}:${string}` | `support:${string}`;

/**
 * Chat with the admins: every player has one support thread (`support:<player id>`) that all admins see and answer.
 * A player sends to `SUPPORT_KEY`; an admin sends to the thread's channel name.
 */
export const SUPPORT_KEY = 'support';

export function supportChannel(userId: string): ChatChannel {
  return `support:${userId}`;
}

/** The player a support thread belongs to, or null when `channel` is not one. */
export function supportOwner(channel: string): string | null {
  return /^support:([0-9a-f-]{36})$/.exec(channel)?.[1] ?? null;
}

export const CHAT_MAX_LENGTH = 200;
export const CHAT_PAGE_SIZE = 50;
export const FRIENDS_MAX = 100;
export const USER_SEARCH_MIN = 2;

/** Both members' ids sorted, so a pair always maps to the same channel. */
export function dmChannel(a: string, b: string): ChatChannel {
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

/** The other member of a DM channel, or null when `channel` is not a DM of `me`. */
export function dmPeer(channel: string, me: string): string | null {
  const m = /^dm:([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(channel);
  if (!m) return null;
  if (m[1] === me) return m[2];
  if (m[2] === me) return m[1];
  return null;
}

/** Trims, collapses whitespace and drops control and bidi characters, then cuts to `max`; '' when nothing is left. */
export function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trim();
}

export function cleanChatText(raw: unknown): string {
  return cleanText(raw, CHAT_MAX_LENGTH);
}

/** Chat bans an admin can hand out; a muted player can still write to the admins in their support thread. */
export const MUTE_OPTIONS = [
  { minutes: 15, label: '15 phút' },
  { minutes: 60, label: '1 giờ' },
  { minutes: 24 * 60, label: '1 ngày' },
  { minutes: 7 * 24 * 60, label: '7 ngày' },
] as const;

export function isMuteMinutes(value: unknown): value is number {
  return value === 0 || MUTE_OPTIONS.some((o) => o.minutes === value);
}

export type Presence = 'offline' | 'online' | 'in_match';

export const PRESENCE_LABELS: Record<Presence, string> = {
  offline: 'Ngoại tuyến',
  online: 'Trực tuyến',
  in_match: 'Đang trong trận',
};

export interface SocialUser {
  id: string;
  username: string;
  avatar: string;
  level: number;
  /** Set only for admin accounts: their name and chat bubble get a distinct style. */
  admin?: boolean;
}

export interface ChatMessage {
  id: string;
  channel: ChatChannel;
  from: SocialUser;
  /** With bad words already masked (`maskProfanity`). */
  text: string;
  /** Only sent to admins, and only when the filter masked something: what the sender actually typed. */
  raw?: string;
  at: string;
}

export interface FriendEntry extends SocialUser {
  presence: Presence;
  unread: number;
}

export interface FriendsState {
  friends: FriendEntry[];
  incoming: SocialUser[];
  outgoing: SocialUser[];
}

export type Relation = 'none' | 'friend' | 'incoming' | 'outgoing';

export interface UserSearchResult extends SocialUser {
  relation: Relation;
  /** Only sent to admins: when the player's chat ban ends, if they have one. */
  mutedUntil?: string;
}

/** A row of the admin accounts page (`GET /api/admin/accounts`). */
export interface AdminAccount extends SocialUser {
  createdAt: string;
  lastLoginAt: string | null;
  matches: number;
  mutedUntil: string | null;
  presence: Presence;
}

export interface AdminAccountList {
  accounts: AdminAccount[];
  /** Every account matching the search; `accounts` holds at most the newest `ADMIN_ACCOUNTS_PAGE`. */
  total: number;
}

export const ADMIN_ACCOUNTS_PAGE = 50;

/** A player's side of the support chat (`support:status`). */
export interface SupportStatus {
  unread: number;
  /** Whether any admin is connected right now. */
  adminOnline: boolean;
}

/** One conversation in the admins' support inbox (`support:inbox`), newest first. */
export interface SupportThread {
  user: SocialUser;
  presence: Presence;
  last: { text: string; at: string; fromAdmin: boolean };
  /** Messages from the player this admin has not read yet. */
  unread: number;
}

/** Every social request is answered through a Socket.IO ack in this shape. */
export type SocialAck<T = object> = ({ ok: true } & T) | { ok: false; error: string };
