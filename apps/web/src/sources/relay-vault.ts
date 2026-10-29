import type { RelaySession, RelayVault } from "./relay-access";

/**
 * 经中继进主机的页面用的保管处（从 `hosted.ts` 抽出，与会话来源无关）：内存里的
 * 访问令牌，加 `sessionStorage` / `localStorage` 里刷新页面要续上的那份记录
 * （两把刷新令牌、上次进的主机），以及按 签发方 + 链接 的访客记录。
 */

/* --------------------------------- 保管处 --------------------------------- */

export interface MemoryRelayVault extends RelayVault {
  clear(): void;
}

/** 只在内存里的保管处：一个签发方一把刷新令牌，一个源一份会话。 */
export function createMemoryRelayVault(): MemoryRelayVault {
  const remotes = new Map<string, string>();
  const sessions = new Map<string, RelaySession>();
  return {
    cloudRefreshToken: async (issuer) => remotes.get(issuer) ?? null,
    async saveCloudRefreshToken(issuer, refreshToken) {
      remotes.set(issuer, refreshToken);
    },
    async forgetCloud(issuer) {
      remotes.delete(issuer);
    },
    session: async (sourceId) => sessions.get(sourceId),
    async saveSession(sourceId, _issuer, session) {
      sessions.set(sourceId, session);
    },
    clear() {
      remotes.clear();
      sessions.clear();
    },
  };
}

/* ------------------------------ 刷新后续上 ------------------------------- */

/**
 * 刷新页面要续上的那点东西：两把刷新令牌与上次进的主机。访问令牌不落盘——
 * 续的时候用刷新令牌换新的（都会旋转，旧的随即作废）。
 *
 * 放 `sessionStorage` 而不是 `localStorage` / IndexedDB：只活在这个标签页里，
 * 关掉即丢，和以前「凭据只在这个标签页」的边界一致；中继给页面的 CSP 只许
 * `script-src 'self'`、`connect-src 'self'`，读得到它的脚本本来就能用内存里的
 * 令牌发请求，多记两把刷新令牌不扩大 XSS 能做的事，只延长到刷新之后。
 */
export const HOSTED_RESUME_KEY = "armadra.hosted.resume";

interface ResumeRecord {
  readonly issuer: string;
  readonly cloudRefreshToken: string | null;
  /** 源 core 的刷新令牌，按源。 */
  readonly sources: Readonly<Record<string, string>>;
  /** 上次进的主机；还没进过是 `null`。 */
  readonly entered: { readonly sourceId: string; readonly name: string } | null;
  /** 访客记录的寿命（毫秒时刻，= 链接到期）；账号那份没有。 */
  readonly expiresAtMs?: number;
  /**
   * 访客记录是谁接受的链接：控制台账号 id，匿名接受是 `""`。没有这一项是来源不明
   * （B3 之前写的记录）：控制台 `/h/` 不采用（{@link guestLinkFor}）。
   */
  readonly acceptedBy?: string;
  /** 访客看到的分享：权限、主人 / 工作空间名；账号那份没有。 */
  readonly share?: GuestShare;
}

/** 访客加入的这份分享（顶栏显示用）。 */
export interface GuestShare {
  /** `viewer` / `editor` / `operator` / `driver`；不知道是空串。 */
  readonly role: string;
  /** 分享给你的工作空间 / 主机名；不知道是空串。 */
  readonly name: string;
  /** 主人名字；不知道是空串。 */
  readonly ownerName: string;
  /** 链接到期（毫秒时刻）。 */
  readonly expiresAtMs: number;
}

export function browserSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readResume(
  storage: Storage | null,
  issuer: string,
  key: string = HOSTED_RESUME_KEY,
  now: number = Date.now(),
): ResumeRecord {
  const empty: ResumeRecord = {
    issuer,
    cloudRefreshToken: null,
    sources: {},
    entered: null,
  };
  try {
    const raw = storage?.getItem(key);
    if (!raw) return empty;
    const value = JSON.parse(raw) as Partial<ResumeRecord>;
    // 别的签发方留下的（同一来源不会有，但别信它）：不用。
    if (value.issuer !== issuer) return empty;
    // 访客记录到期即作废（连同存储里那份）。
    if (typeof value.expiresAtMs === "number" && value.expiresAtMs <= now) {
      storage?.removeItem(key);
      return empty;
    }
    const sources: Record<string, string> = {};
    for (const [id, token] of Object.entries(value.sources ?? {}))
      if (typeof token === "string" && token !== "") sources[id] = token;
    const entered = value.entered;
    const share = value.share;
    return {
      issuer,
      ...(typeof value.expiresAtMs === "number"
        ? { expiresAtMs: value.expiresAtMs }
        : {}),
      ...(typeof value.acceptedBy === "string"
        ? { acceptedBy: value.acceptedBy }
        : {}),
      ...(share && typeof share === "object"
        ? {
            share: {
              role: typeof share.role === "string" ? share.role : "",
              name: typeof share.name === "string" ? share.name : "",
              ownerName:
                typeof share.ownerName === "string" ? share.ownerName : "",
              expiresAtMs:
                typeof share.expiresAtMs === "number" ? share.expiresAtMs : 0,
            },
          }
        : {}),
      cloudRefreshToken:
        typeof value.cloudRefreshToken === "string" &&
        value.cloudRefreshToken !== ""
          ? value.cloudRefreshToken
          : null,
      sources,
      entered:
        entered &&
        typeof entered.sourceId === "string" &&
        entered.sourceId !== ""
          ? {
              sourceId: entered.sourceId,
              name: typeof entered.name === "string" ? entered.name : "",
            }
          : null,
    };
  } catch {
    return empty;
  }
}

function writeResume(
  storage: Storage | null,
  record: ResumeRecord,
  key: string = HOSTED_RESUME_KEY,
): void {
  try {
    if (record.cloudRefreshToken === null) {
      storage?.removeItem(key);
      return;
    }
    storage?.setItem(key, JSON.stringify(record));
  } catch {
    /* 存不下只是刷新后要重新登录。 */
  }
}

/* ------------------------------- 访客保管处 ------------------------------- */

/** 访客记录的键前缀：`armadra.guest.<签发方>|<链接>`，按 签发方 + 链接 各一份。 */
export const GUEST_KEY_PREFIX = "armadra.guest.";

export function guestKey(issuer: string, linkId: string): string {
  return `${GUEST_KEY_PREFIX}${issuer}|${linkId}`;
}

export function browserLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 这个签发方下还没到期的访客记录的键；到期的顺手清掉。 */
export function guestKeys(
  storage: Storage | null,
  issuer: string,
  now: number = Date.now(),
): string[] {
  if (storage === null) return [];
  const prefix = `${GUEST_KEY_PREFIX}${issuer}|`;
  const keys: string[] = [];
  try {
    for (let at = 0; at < storage.length; at += 1) {
      const key = storage.key(at);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys.filter(
      (key) => readResume(storage, issuer, key, now).cloudRefreshToken !== null,
    );
  } catch {
    return [];
  }
}

/**
 * 进过 `sourceId` 这台主机、这位可以用的访客记录是哪条链接的（控制台 `/h/` 用，设计 saas-host-open §2.8）；
 * 没有、都到期了答 `null`。有几条时取到期最晚的那条。
 *
 * `accountId`：当前控制台账号（没有 Cookie 会话是 `null`）。只采用匿名接受的记录（`acceptedBy` 为
 * `""`）与这位自己接受的记录：别的账号接受的不能拿来绕过团队「要登录」的设置、也不能串到别的账号上。
 * 没有 `acceptedBy` 的旧记录来源不明——可能是哪个账号在要求登录的团队里接受的——一律不采用。
 */
export function guestLinkFor(
  storage: Storage | null,
  issuer: string,
  sourceId: string,
  accountId: string | null,
  now: number = Date.now(),
): string | null {
  const prefix = `${GUEST_KEY_PREFIX}${issuer}|`;
  let best: { linkId: string; expiresAtMs: number } | null = null;
  for (const key of guestKeys(storage, issuer, now)) {
    const record = readResume(storage, issuer, key, now);
    if (record.entered?.sourceId !== sourceId) continue;
    if (!usableBy(record.acceptedBy, accountId)) continue;
    const expiresAtMs = record.expiresAtMs ?? Number.POSITIVE_INFINITY;
    if (best === null || expiresAtMs > best.expiresAtMs)
      best = { linkId: key.slice(prefix.length), expiresAtMs };
  }
  return best?.linkId ?? null;
}

/**
 * 访客记录这位能不能用（§2.8）：匿名接受的（`""`）谁都能用；账号接受的只给那个账号；
 * 没有 `acceptedBy` 的来源不明，谁都不用。`accountId`：当前控制台账号，没有会话是 `null`。
 */
export function usableBy(
  acceptedBy: string | undefined,
  accountId: string | null,
): boolean {
  return acceptedBy === "" || (accountId !== null && acceptedBy === accountId);
}

/** 这条链接的访客记录（没到期、带刷新令牌）是谁接受的；没有记录答 `null`，来源不明答 `undefined`。 */
export function guestAcceptedBy(
  storage: Storage | null,
  issuer: string,
  linkId: string,
  now: number = Date.now(),
): string | undefined | null {
  const key = guestKey(issuer, linkId);
  if (!guestKeys(storage, issuer, now).includes(key)) return null;
  return readResume(storage, issuer, key, now).acceptedBy;
}

/**
 * 这条链接是否已经加入过、且这位能续上：存储里有它没到期、还带刷新令牌的访客记录，并且
 * {@link usableBy}。`accountId` 缺省（个人中转的落地页）不按接受者过滤。
 */
export function hasGuestRecord(
  issuer: string,
  linkId: string,
  accountId?: string | null,
): boolean {
  const by = guestAcceptedBy(browserLocalStorage(), issuer, linkId);
  if (by === null) return false;
  return accountId === undefined || usableBy(by, accountId);
}

/** 丢掉这个签发方下全部访客记录（账号登录是明确换身份）。 */
export function clearGuestRecords(
  storage: Storage | null,
  issuer: string,
): void {
  if (storage === null) return;
  try {
    const prefix = `${GUEST_KEY_PREFIX}${issuer}|`;
    const keys: string[] = [];
    for (let at = 0; at < storage.length; at += 1) {
      const key = storage.key(at);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* 清不掉只是下次刷新还试它。 */
  }
}

/**
 * 控制台登出：丢掉这个签发方下由账号接受的访客记录（`acceptedBy` 非空）与来源不明的旧记录，
 * 匿名接受的留着（它们本来就不属于哪个账号）。
 */
export function clearAccountGuestRecords(
  storage: Storage | null,
  issuer: string,
): void {
  if (storage === null) return;
  try {
    const prefix = `${GUEST_KEY_PREFIX}${issuer}|`;
    const keys: string[] = [];
    for (let at = 0; at < storage.length; at += 1) {
      const key = storage.key(at);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      let acceptedBy: unknown;
      try {
        acceptedBy = (
          JSON.parse(storage.getItem(key) ?? "{}") as { acceptedBy?: unknown }
        ).acceptedBy;
      } catch {
        acceptedBy = undefined;
      }
      if (acceptedBy !== "") storage.removeItem(key);
    }
  } catch {
    /* 清不掉的，`/h/` 也只给接受它的那位用。 */
  }
}

export interface SessionVaultOptions {
  /** 存储里的键；缺省是账号那一份 {@link HOSTED_RESUME_KEY}。 */
  readonly key?: string;
  /** 记录的寿命（毫秒时刻）；到期读不出来、写时带上。 */
  readonly expiresAtMs?: number;
  /** 访客记录是谁接受的（账号 id，匿名 `""`）；写时带上。 */
  readonly acceptedBy?: string;
  /**
   * 新加入：不读存储里同一个键的旧记录，从空白开始（旧记录的 `acceptedBy` 等不能沿用到新记录上）。
   * 续上时不给，读回原记录，令牌旋转保留它的 `acceptedBy`。
   */
  readonly fresh?: boolean;
  readonly now?: () => number;
}

export interface SessionRelayVault extends MemoryRelayVault {
  /** 记下（或忘掉）上次进的主机。 */
  rememberEntered(source: { sourceId: string; name: string } | null): void;
  /** 上次进的主机；没有可续的就是 `null`。 */
  entered(): { sourceId: string; name: string } | null;
  /** 访客的分享信息（只有访客那份记）。 */
  rememberShare(share: GuestShare): void;
  share(): GuestShare | null;
}

/**
 * 内存保管处加一层 `sessionStorage`：刷新令牌写穿，访问令牌只在内存。启动时
 * 从存储读回刷新令牌；源 core 的会话读回时访问令牌为空、已过期，用它的人
 * （`relay-access.ts`）会先轮换。
 */
export function createSessionRelayVault(
  issuer: string,
  storage: Storage | null = browserSessionStorage(),
  options: SessionVaultOptions = {},
): SessionRelayVault {
  const key = options.key ?? HOSTED_RESUME_KEY;
  const memory = createMemoryRelayVault();
  const stamp = (next: ResumeRecord): ResumeRecord => ({
    ...next,
    ...(options.expiresAtMs === undefined
      ? {}
      : { expiresAtMs: options.expiresAtMs }),
    ...(options.acceptedBy === undefined
      ? {}
      : { acceptedBy: options.acceptedBy }),
  });
  let record = stamp(
    options.fresh === true
      ? { issuer, cloudRefreshToken: null, sources: {}, entered: null }
      : readResume(storage, issuer, key, options.now?.()),
  );
  /** 访客记录（按链接的那份）已经落过盘：之后存储里没了就是被外部删了（控制台登出清的）。 */
  const guestRecord = options.key !== undefined;
  let stored = record.cloudRefreshToken !== null;
  const save = (next: ResumeRecord) => {
    if (guestRecord && stored) {
      let present = true;
      try {
        present = storage?.getItem(key) != null;
      } catch {
        /* 读不了就照常写。 */
      }
      // 被外部删掉的访客记录不再写回（否则旋转令牌时又把它复活）；这一页内存里的照用。
      if (!present) {
        record = stamp(next);
        return;
      }
    }
    record = stamp(next);
    writeResume(storage, record, key);
    stored = record.cloudRefreshToken !== null;
  };
  const clear = () => {
    stored = false;
    memory.clear();
    record = stamp({
      issuer,
      cloudRefreshToken: null,
      sources: {},
      entered: null,
    });
    try {
      storage?.removeItem(key);
    } catch {
      /* 没存下过。 */
    }
  };
  return {
    async cloudRefreshToken(of) {
      return (
        (await memory.cloudRefreshToken(of)) ??
        (of === issuer ? record.cloudRefreshToken : null)
      );
    },
    async saveCloudRefreshToken(of, refreshToken) {
      await memory.saveCloudRefreshToken(of, refreshToken);
      if (of === issuer) save({ ...record, cloudRefreshToken: refreshToken });
    },
    async forgetCloud(of) {
      await memory.forgetCloud?.(of);
      if (of === issuer) clear();
    },
    async session(sourceId) {
      const live = await memory.session(sourceId);
      if (live !== undefined) return live;
      const refreshToken = record.sources[sourceId];
      // 过期的空访问令牌：取用前一定先轮换。
      return refreshToken === undefined
        ? undefined
        : { accessToken: "", refreshToken, expiresAtMs: 1 };
    },
    async saveSession(sourceId, of, session) {
      await memory.saveSession(sourceId, of, session);
      if (record.sources[sourceId] !== session.refreshToken)
        save({
          ...record,
          sources: { ...record.sources, [sourceId]: session.refreshToken },
        });
    },
    rememberEntered(source) {
      save({ ...record, entered: source });
    },
    entered: () => (record.cloudRefreshToken === null ? null : record.entered),
    rememberShare(share) {
      save({ ...record, share });
    },
    share: () =>
      record.cloudRefreshToken === null ? null : (record.share ?? null),
    clear,
  };
}
