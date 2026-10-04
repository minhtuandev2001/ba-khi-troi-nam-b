/**
 * Word-list profanity filter shared by both sides: chat messages are masked on the server, account and room
 * names are refused (on the form already, and again on the server).
 *
 * Vietnamese without its marks collides with everyday words ("cặc"/"các", "lồn"/"lon", "buồi"/"buổi",
 * "đụ mẹ"/"dù mẹ"), so those words only count when typed with their marks. Unmarked forms count only when
 * they cannot mean anything else: teencode, words run together, a few two-word phrases. Every letter may be
 * typed several times ("đmmm", "fuuuck"), digits may stand for letters ("d1t"), and single letters may be
 * spread out ("v.c.l", "đ m").
 */

/** Whole words, matched with their marks. */
const MARKED_WORDS = ['cặc', 'cặk', 'lồn', 'lìn', 'buồi', 'địt', 'đụ', 'đéo', 'đĩ', 'đm', 'đmm', 'đcm', 'đkm', 'đmml'];
/** Whole words, matched without marks; none of them is a real word. ("dm" is not here: it also means a direct message.) */
const PLAIN_WORDS = [
  'dmm', 'dcm', 'dkm', 'dmml', 'dmvl', 'vcl', 'vkl', 'vcc', 'clm', 'cml', 'cmm', 'djt', 'loz', 'cak',
  'fuck', 'fck', 'fuk', 'fucking', 'fucker', 'fucked', 'motherfucker', 'shit', 'bitch', 'cunt', 'pussy', 'asshole',
];
/** Found anywhere inside a word written without spaces ("ditmemay", "Con_Cac99"). */
const RUN_TOGETHER = ['ditme', 'ditconme', 'dume', 'duma', 'cailon', 'concac', 'liemlon', 'dmm', 'dcm', 'dkm', 'vcl', 'vkl', 'clm', 'cmm', 'djt', 'fuck', 'bitch', 'pussy', 'asshole'];
/** Two words in a row, matched without marks. */
const PHRASES = ['dit me', 'dit ma', 'con cac', 'liem lon'];
/** Names only: harmless in a sentence without marks, but not as a whole part of a name ("lon_99", "CacVip"). */
const NAME_PARTS = ['lon', 'cac', 'buoi', 'dit', 'dm', 'loz'];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };

/** Every letter may repeat; a doubled letter in the list needs at least two. */
function loose(word: string): string {
  let out = '';
  for (let i = 0; i < word.length; ) {
    let j = i;
    while (word[j] === word[i]) j++;
    const c = word[i];
    out += c === ' ' ? ' ' : `${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${j - i > 1 ? `{${j - i},}` : '+'}`;
    i = j;
  }
  return out;
}

const whole = (list: string[]) => new RegExp(`^(?:${list.map(loose).join('|')})$`, 'u');
const MARKED_RE = whole(MARKED_WORDS);
const PLAIN_RE = whole(PLAIN_WORDS);
const PHRASE_RE = whole(PHRASES);
const NAME_PART_RE = whole(NAME_PARTS);
const RUN_TOGETHER_RE = new RegExp(`(?:${RUN_TOGETHER.map(loose).join('|')})`, 'u');

/** Lower case, Vietnamese marks dropped, đ read as d, and digits read as letters inside a word. */
function toPlain(word: string): string {
  const p = word.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  return /\p{L}/u.test(p) ? p.replace(/[013457]/g, (d) => LEET[d]) : p;
}

interface Token {
  start: number;
  end: number;
  marked: string;
  plain: string;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    out.push({ start: m.index, end: m.index + m[0].length, marked: m[0].toLowerCase(), plain: toPlain(m[0]) });
  }
  return out;
}

const badWord = (marked: string, plain: string) => MARKED_RE.test(marked) || PLAIN_RE.test(plain) || RUN_TOGETHER_RE.test(plain);

/** Indexes of the tokens that are (part of) a bad word. */
function findBad(tokens: Token[]): Set<number> {
  const bad = new Set<number>();
  tokens.forEach((t, i) => {
    if (badWord(t.marked, t.plain)) bad.add(i);
    const next = tokens[i + 1];
    if (next && PHRASE_RE.test(`${t.plain} ${next.plain}`)) bad.add(i).add(i + 1);
  });
  // single letters spread out with spaces or dots ("đ m", "v.c.l"): try every run of two or more
  for (let i = 0; i < tokens.length; i++) {
    let j = i;
    while (j < tokens.length && tokens[j].end - tokens[j].start === 1 && (j === i || tokens[j].start - tokens[j - 1].end <= 3)) j++;
    for (let a = i; a < j; a++) {
      for (let b = a + 2; b <= j; b++) {
        const run = tokens.slice(a, b);
        if (badWord(run.map((t) => t.marked).join(''), run.map((t) => t.plain).join(''))) for (let k = a; k < b; k++) bad.add(k);
      }
    }
    if (j > i) i = j - 1;
  }
  return bad;
}

/** Chat: the message with every bad word replaced by stars, and how many words were hidden. */
export function maskProfanity(text: string): { text: string; hits: number } {
  const normal = text.normalize('NFC');
  const tokens = tokenize(normal);
  const bad = findBad(tokens);
  if (!bad.size) return { text: normal, hits: 0 };
  let out = '';
  let pos = 0;
  for (const i of [...bad].sort((a, b) => a - b)) {
    const t = tokens[i];
    out += normal.slice(pos, t.start) + '*'.repeat([...normal.slice(t.start, t.end)].length);
    pos = t.end;
  }
  return { text: out + normal.slice(pos), hits: bad.size };
}

/** Free-text names (rooms): refused when chat would hide any of it. */
export function textHasProfanity(text: string): boolean {
  return maskProfanity(text).hits > 0;
}

/** Account names (letters, digits, underscores): also checks the parts between underscores, digits and capitals. */
export function nameHasProfanity(name: string): boolean {
  if (RUN_TOGETHER_RE.test(toPlain(name.replace(/_/g, '')))) return true;
  const parts = name.split(/[_\d]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map(toPlain);
  return parts.some((p, i) => PLAIN_RE.test(p) || NAME_PART_RE.test(p) || (i > 0 && PHRASE_RE.test(`${parts[i - 1]} ${p}`)));
}
