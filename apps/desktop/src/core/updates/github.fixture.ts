/**
 * 测试用：GitHub 发布列表的假条目与假 `fetch`。不联网。
 */

/** GitHub 发布列表里的一项（只写用到的字段）。 */
export function githubRelease(
  tag: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: "2026-10-20T00:00:00Z",
    created_at: "2026-10-19T00:00:00Z",
    body: `notes ${tag}`,
    html_url: `https://releases.example.test/tag/${tag}`,
    assets: [],
    ...extra,
  };
}

export interface FakeAnswer {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export interface FakeGithub {
  readonly fetch: typeof globalThis.fetch;
  /** 每次请求的地址与请求头（小写键）。 */
  readonly requests: { url: string; headers: Record<string, string> }[];
  /** 下一次（以及之后，直到再换）怎么答；函数则每次现算。 */
  answer(next: FakeAnswer | (() => FakeAnswer) | Error): void;
}

export function fakeGithub(initial: FakeAnswer): FakeGithub {
  let current: FakeAnswer | (() => FakeAnswer) | Error = initial;
  const requests: FakeGithub["requests"] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({ url: String(input), headers });
    if (current instanceof Error) throw current;
    const answer = typeof current === "function" ? current() : current;
    return new Response(
      answer.body === undefined ? null : JSON.stringify(answer.body),
      { status: answer.status, headers: answer.headers ?? {} },
    );
  }) as typeof globalThis.fetch;
  return {
    fetch,
    requests,
    answer(next) {
      current = next;
    },
  };
}
