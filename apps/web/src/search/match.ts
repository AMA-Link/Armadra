/**
 * 搜索的匹配规则（纯函数，侧栏搜索与 ⌘K 共用）。
 *
 * 一个查询词按空白切成若干词，每个词都要在某个字段里命中才算命中；命中的
 * 档位决定得分：全等 > 前缀 > 词首 > 子串 > 拼音首字母 > 子序列模糊。
 * 拼音首字母用 `Intl.Collator("zh-u-co-pinyin")` 现算，不带词典：多音字取
 * 排序规则里的默认读音（「重」读 zhong），尽力而为；运行环境没有拼音排序
 * 规则时（`Intl` 精简构建）退化成不匹配首字母，其余档位不受影响。
 */

/** 一个已归一化的字段：小写文本与拼音首字母各算一次。 */
export interface Prepared {
  readonly text: string;
  readonly initials: string;
}

const HAN = /\p{Script=Han}/u;

/** 拼音首字母的边界字（按拼音排序，每个字母取该字母区间里最靠前的一个字）。 */
// 阿八嚓哒妸发旮哈讥咔垃妈拿噢妑七呥仨他挖夕丫帀（写成转义：源码里不放中文字面量）
const BOUNDARY_CHARS =
  "\u963f\u516b\u5693\u54d2\u59b8\u53d1\u65ee\u54c8\u8ba5\u5494\u5783\u5988\u62ff\u5662\u5991\u4e03\u5465\u4ee8\u4ed6\u6316\u5915\u4e2b\u5e00";
const BOUNDARY_LETTERS = "abcdefghjklmnopqrstwxyz";

let collator: Intl.Collator | null | undefined;
const initialCache = new Map<string, string>();

function pinyinCollator(): Intl.Collator | null {
  if (collator !== undefined) return collator;
  try {
    const candidate = new Intl.Collator("zh-u-co-pinyin");
    // 不支持时会静默退回默认排序：用一对已知顺序的字验一下。
    collator =
      candidate.compare(BOUNDARY_CHARS[1]!, BOUNDARY_CHARS[0]!) > 0 &&
      candidate.compare(BOUNDARY_CHARS[22]!, BOUNDARY_CHARS[20]!) > 0
        ? candidate
        : null;
  } catch {
    collator = null;
  }
  return collator;
}

/** 一个汉字的拼音首字母；认不出返回空串。 */
function hanInitial(char: string): string {
  const cached = initialCache.get(char);
  if (cached !== undefined) return cached;
  const sorter = pinyinCollator();
  let letter = "";
  if (sorter) {
    let found = -1;
    for (let index = 0; index < BOUNDARY_CHARS.length; index += 1) {
      if (sorter.compare(BOUNDARY_CHARS[index]!, char) <= 0) found = index;
      else break;
    }
    letter = found < 0 ? "" : BOUNDARY_LETTERS[found]!;
  }
  initialCache.set(char, letter);
  return letter;
}

/** 小写、全半角归一、空白压成一个空格。 */
export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 拼音首字母串：汉字取首字母，字母与数字原样保留，其余（空格、标点）丢掉。
 * 「画布 4」→ `hb4`，「MacBookPro.local」→ `macbookprolocal`。
 */
export function pinyinInitials(text: string): string {
  let out = "";
  for (const char of normalize(text)) {
    if (HAN.test(char)) out += hanInitial(char);
    else if (/[\p{L}\p{N}]/u.test(char)) out += char;
  }
  return out;
}

export function prepare(text: string): Prepared {
  const text_ = normalize(text);
  return { text: text_, initials: pinyinInitials(text_) };
}

/** 把查询切成词（已归一化、去重）。空查询返回空数组。 */
export function parseQuery(query: string): string[] {
  const terms = normalize(query)
    .split(" ")
    .filter((term) => term !== "");
  return [...new Set(terms)];
}

/** 词首：命中位置前一个字符不是字母或数字（空格、标点、汉字之后接字母都算）。 */
function atWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  return !/[a-z0-9]/.test(text[index - 1]!) || !/[a-z0-9]/.test(text[index]!);
}

/**
 * 子序列：`term` 的每个字符按顺序出现在 `text` 里，且跨度不超过词长的三倍，
 * 免得两个字母散在一整段正文里也算命中。返回紧凑程度 0–1，不命中返回 0。
 */
function subsequence(term: string, text: string): number {
  if (term.length < 2 || text.length < term.length) return 0;
  const first = text.indexOf(term[0]!);
  if (first < 0) return 0;
  let at = first;
  for (let index = 1; index < term.length; index += 1) {
    at = text.indexOf(term[index]!, at + 1);
    if (at < 0) return 0;
  }
  const span = at - first + 1;
  if (span > term.length * 3) return 0;
  return term.length / span;
}

/**
 * 一个词对一个字段的得分，0 表示不命中。
 *
 * 100 全等；90 前缀；75 词首；50–60 子串（越靠前越高）；
 * 45–55 拼音首字母；20–35 子序列模糊。
 */
export function scoreTerm(
  term: string,
  field: Prepared,
  allowInitials = true,
): number {
  const { text, initials } = field;
  if (text === "") return 0;
  if (text === term) return 100;
  const at = text.indexOf(term);
  if (at === 0) return 90;
  if (at > 0) {
    if (atWordStart(text, at)) return 75;
    return 60 - Math.min(at, 20) * 0.5;
  }
  // 拼音首字母只对由字母数字组成的词有意义（汉字词已经走了子串），且只看短字段：
  // 一段正文的首字母串里总能碰上任意两个字母。
  if (
    allowInitials &&
    term.length >= 2 &&
    text.length <= INITIALS_MAX_LENGTH &&
    /^[a-z0-9]+$/.test(term)
  ) {
    const index = initials.indexOf(term);
    if (index === 0) return 55;
    if (index > 0) return 45;
  }
  const fuzzy = subsequence(term, text);
  if (fuzzy > 0) return 20 + fuzzy * 15;
  return 0;
}

/** 超过这个长度的字段不比对拼音首字母。 */
const INITIALS_MAX_LENGTH = 40;

/** 次要字段的权重：同样命中，标题比正文、路径更值钱。 */
const SECONDARY_WEIGHT = 0.6;

export interface Scored {
  /** 0 = 不命中。 */
  readonly score: number;
  /** 命中靠的是次要字段（标题没有把所有词都命中）：调用方据此显示摘要。 */
  readonly viaSecondary: boolean;
}

const MISS: Scored = { score: 0, viaSecondary: false };

/**
 * 一个条目（主字段 + 若干次要字段）对整个查询的得分：每个词取各字段里的最高
 * 加权分，所有词都得分才算命中，总分是各词得分的平均。
 */
export function scoreFields(
  terms: readonly string[],
  primary: Prepared,
  secondary: readonly Prepared[] = [],
): Scored {
  if (terms.length === 0) return { score: 1, viaSecondary: false };
  let total = 0;
  let viaSecondary = false;
  for (const term of terms) {
    const title = scoreTerm(term, primary);
    let best = title;
    for (const field of secondary) {
      // 次要字段（正文、路径）不比对拼音首字母：一段话的首字母串里总能碰上。
      const value = scoreTerm(term, field, false) * SECONDARY_WEIGHT;
      if (value > best) best = value;
    }
    if (best <= 0) return MISS;
    if (title <= 0) viaSecondary = true;
    total += best;
  }
  return { score: total / terms.length, viaSecondary };
}

/** 便捷：只对一段文字打分（命令、设置项这类只有一个字段的条目）。 */
export function scoreText(terms: readonly string[], text: string): number {
  return scoreFields(terms, prepare(text)).score;
}
