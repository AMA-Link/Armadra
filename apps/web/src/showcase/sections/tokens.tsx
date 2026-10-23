import * as React from "react";

import { useT } from "@/app/preferences-store";
import { AgentAvatar } from "@/ui/agent-avatar";
import { Button } from "@/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { tokenContrast, type ContrastPair } from "../harness";

/**
 * `tokens` 分区（设计展示页 §2.1）：设计系统 §2 的每个语义 token。
 * 色块下方印 token 名与浏览器里实测的对比度——读的是计算样式，不是源文件。
 */

const AGENTS = ["claude", "codex", "opencode", "pi", "omp", "copilot", "ama"];
const SURFACES = [
  "--bg",
  "--panel",
  "--surface-card",
  "--surface-raised",
  "--surface-overlay",
  "--canvas-bg",
  "--term-bg",
];
const TEXTS = ["--text", "--muted-foreground", "--faint"];
const BRAND = ["--brand", "--brand-text", "--brand-solid", "--focus-ring"];
const STATUS: [string, string, string | null][] = [
  ["--danger", "--danger-text", "--danger-soft"],
  ["--warn", "--warn-text", "--warn-soft"],
  ["--caution", "--caution-text", "--caution-soft"],
  ["--success", "--success-text", "--success-soft"],
  ["--agent-working", "--working-text", "--agent-working-soft"],
];
/** 六档语义字号类。 */
const TYPE_SCALE = [
  ["--text-display", "text-display"],
  ["--text-title", "text-title"],
  ["--text-section", "text-section"],
  ["--text-body", "text-body"],
  ["--text-meta", "text-meta"],
  ["--text-caption", "text-caption"],
] as const;
/** 七档语义圆角，类名与令牌一一对应。 */
const RADII = [
  ["--r-tight", "rounded-tight"],
  ["--r-control", "rounded-control"],
  ["--r-card", "rounded-card"],
  ["--r-panel", "rounded-panel"],
  ["--r-dialog", "rounded-dialog"],
  ["--r-float", "rounded-float"],
  ["--r-pill", "rounded-pill"],
] as const;
/** 三档阴影；卡片没有阴影，只有 1px 边。 */
const SHADOWS = [
  ["--shadow-node", "shadow-node"],
  ["--shadow-overlay", "shadow-overlay"],
  ["--shadow-dialog", "shadow-dialog"],
] as const;
const DURATIONS = [
  "--dur-instant",
  "--dur-fast",
  "--dur-base",
  "--dur-slow",
  "--dur-page",
  "--dur-hero",
];
const CURVES = ["--ease-out", "--ease-in-out", "--ease-drawer", "--ease-color"];
const LAYERS = [
  "--z-pills",
  "--z-canvas-overlay",
  "--z-sessions",
  "--z-dock",
  "--z-cluster",
  "--z-banners",
  "--z-shared-session",
  "--z-tabbar",
  "--z-focus",
  "--z-menu",
  "--z-dialog",
  "--z-focus-page",
  "--z-toast",
  "--z-splash",
];

/** 挂载后量一次：主题由 URL 定，页面开着时不会变。 */
function useMeasured<T>(read: () => T): T | null {
  const [value, setValue] = React.useState<T | null>(null);
  React.useLayoutEffect(() => setValue(read()), [read]);
  return value;
}

function Ratio({ pair }: { pair: Omit<ContrastPair, "kind"> }) {
  const { fg, bg, over, alpha } = pair;
  const read = React.useCallback(
    () =>
      tokenContrast({
        fg,
        bg,
        ...(over === undefined ? {} : { over }),
        ...(alpha === undefined ? {} : { alpha }),
      }),
    [fg, bg, over, alpha],
  );
  const ratio = useMeasured(read);
  return (
    <span className="font-mono text-caption text-muted-foreground tabular-nums">
      {ratio === null ? "" : ratio.toFixed(1)}
    </span>
  );
}

function TokenName({ name }: { name: string }) {
  return (
    <span className="font-mono text-caption break-all text-muted-foreground">
      {name}
    </span>
  );
}

/** 一个色块 + 名字 + 对比度（`pair` 缺省时不印数）。 */
function Swatch({
  token,
  pair,
  children,
}: {
  token: string;
  pair?: Omit<ContrastPair, "kind">;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex w-28 flex-col gap-1" data-token={token}>
      <div
        className="flex h-12 items-center justify-center rounded-control border border-border"
        style={{ background: `var(${token})` }}
      >
        {children}
      </div>
      <TokenName name={token} />
      {pair ? <Ratio pair={pair} /> : null}
    </div>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-section font-medium">{title}</h3>
      <div className="flex flex-wrap gap-3">{children}</div>
    </div>
  );
}

const CARD = "--surface-card";

export default function TokensSection() {
  const t = useT();
  const [played, setPlayed] = React.useState(false);
  const readLayers = React.useCallback(() => {
    const style = getComputedStyle(document.documentElement);
    return LAYERS.map(
      (name) => [name, style.getPropertyValue(name).trim()] as const,
    );
  }, []);
  const layers = useMeasured(readLayers);

  return (
    <div className="flex flex-col gap-6">
      <Group title={t("showcase.tokens.surfaces")}>
        {SURFACES.map((token) => (
          <Swatch
            key={token}
            token={token}
            pair={{
              fg: token === "--term-bg" ? "--term-fg" : "--text",
              bg: token,
            }}
          />
        ))}
      </Group>

      <Group title={t("showcase.tokens.text")}>
        {TEXTS.map((token) => (
          <div key={token} className="flex w-28 flex-col gap-1">
            <div
              className="flex h-12 items-center rounded-control border border-border bg-card px-2 text-body"
              style={{ color: `var(${token})` }}
            >
              Aa
            </div>
            <TokenName name={token} />
            <Ratio pair={{ fg: token, bg: CARD }} />
          </div>
        ))}
      </Group>

      <Group title={t("showcase.tokens.brand")}>
        {BRAND.map((token) => (
          <Swatch
            key={token}
            token={token}
            pair={
              token === "--brand-solid"
                ? { fg: "--on-accent", bg: token }
                : token === "--focus-ring"
                  ? { fg: token, bg: CARD, alpha: 0.5 }
                  : { fg: token, bg: CARD }
            }
          />
        ))}
        <Swatch
          token="--brand-soft"
          pair={{ fg: "--brand-text", bg: CARD, over: "--brand-soft" }}
        />
      </Group>

      <Group title={t("showcase.tokens.status")}>
        {STATUS.map(([graphic, text, soft]) => (
          <div key={graphic} className="flex gap-1">
            <Swatch token={graphic} pair={{ fg: graphic, bg: CARD }} />
            <div className="flex w-28 flex-col gap-1">
              <div
                className="flex h-12 items-center rounded-control border border-border bg-card px-2 text-body font-medium"
                style={{ color: `var(${text})` }}
              >
                Aa
              </div>
              <TokenName name={text} />
              <Ratio pair={{ fg: text, bg: CARD }} />
            </div>
            {soft ? (
              <Swatch token={soft} pair={{ fg: text, bg: CARD, over: soft }} />
            ) : null}
          </div>
        ))}
      </Group>

      <Group title={t("showcase.tokens.agents")}>
        {AGENTS.map((id) => (
          <div key={id} className="flex w-36 flex-col gap-1">
            <div className="flex h-12 items-center gap-2 rounded-control border border-border bg-card px-2">
              <AgentAvatar agentId={id} size={24} />
              <span
                className="text-body font-medium"
                style={{ color: `var(--agent-${id}-text)` }}
              >
                {id}
              </span>
            </div>
            <TokenName name={`--agent-${id}`} />
            <div className="flex gap-2">
              <Ratio pair={{ fg: `--agent-${id}`, bg: CARD }} />
              <Ratio pair={{ fg: `--agent-${id}-text`, bg: CARD }} />
              <Ratio pair={{ fg: "--on-agent", bg: `--agent-${id}` }} />
            </div>
          </div>
        ))}
      </Group>

      <Group title={t("showcase.tokens.members")}>
        {Array.from({ length: 8 }, (_, index) => `--member-${index + 1}`).map(
          (token) => (
            <Swatch key={token} token={token} pair={{ fg: token, bg: CARD }} />
          ),
        )}
      </Group>

      <Group title={t("showcase.tokens.type")}>
        <div className="flex w-full flex-col gap-2">
          {TYPE_SCALE.map(([token, cls]) => (
            <div key={cls} className="flex items-baseline gap-4">
              <span className="w-40 shrink-0">
                <TokenName name={`${cls} · ${token}`} />
              </span>
              <span className={cls} data-type-sample={cls}>
                {t("showcase.tokens.sample")}
              </span>
            </div>
          ))}
          <div className="flex items-baseline gap-4">
            <span className="w-40 shrink-0">
              <TokenName name="font-mono · tabular-nums" />
            </span>
            <span className="font-mono text-meta tabular-nums">
              0123456789 · 1,284 · 142%
            </span>
          </div>
        </div>
      </Group>

      <Group title={t("showcase.tokens.radius")}>
        {RADII.map(([token, cls]) => (
          <div key={token} className="flex w-28 flex-col gap-1">
            <div
              className={`h-12 border border-border-strong bg-card ${cls}`}
              data-radius-sample={cls}
            />
            <TokenName name={`${cls} · ${token}`} />
          </div>
        ))}
      </Group>

      <Group title={t("showcase.tokens.shadow")}>
        <div className="flex w-32 flex-col gap-2 p-2">
          <div
            className="h-12 rounded-card border border-border bg-card"
            data-shadow-sample="none"
          />
          <TokenName name="card · border" />
        </div>
        {SHADOWS.map(([token, cls]) => (
          <div key={token} className="flex w-32 flex-col gap-2 p-2">
            <div
              className={`h-12 rounded-card bg-card ${cls}`}
              data-shadow-sample={cls}
            />
            <TokenName name={`${cls} · ${token}`} />
          </div>
        ))}
      </Group>

      <Group title={t("showcase.tokens.motion")}>
        <div className="flex w-full flex-col gap-2">
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setPlayed((value) => !value)}
          >
            {t("showcase.tokens.play")}
          </Button>
          {DURATIONS.map((token) => (
            <div key={token} className="flex items-center gap-4">
              <span className="w-32 shrink-0">
                <TokenName name={token} />
              </span>
              <div className="relative h-(--row-h) max-w-80 flex-1">
                <div
                  data-motion-sample
                  className="absolute top-0.5 left-0 size-6 rounded-pill bg-brand"
                  style={{
                    transform: played ? "translateX(280px)" : "none",
                    transition: `transform var(${token}) var(--ease-out)`,
                  }}
                />
              </div>
            </div>
          ))}
          <TokenName name={t("showcase.tokens.curves")} />
          {CURVES.map((token) => (
            <div key={token} className="flex items-center gap-4">
              <span className="w-32 shrink-0">
                <TokenName name={token} />
              </span>
              <div className="relative h-(--row-h) max-w-80 flex-1">
                <div
                  data-curve-sample
                  className="absolute top-0.5 left-0 size-6 rounded-pill bg-brand"
                  style={{
                    transform: played ? "translateX(280px)" : "none",
                    transition: `transform var(--dur-page) var(${token})`,
                  }}
                />
              </div>
            </div>
          ))}
          <TokenName name={t("showcase.tokens.scale")} />
          <div className="flex flex-wrap items-center gap-6 text-meta">
            <span className="font-mono text-muted-foreground">
              --press-scale · --pop-scale · --stagger
            </span>
            {(["--press-scale", "--pop-scale"] as const).map((token) => (
              <div
                key={token}
                data-scale-sample={token}
                className="h-8 w-20 rounded-control border border-border-strong bg-card"
                style={{
                  transform: played ? `scale(var(${token}))` : "none",
                  transition: "transform var(--dur-base) var(--ease-out)",
                }}
              />
            ))}
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <span
                key={index}
                data-stagger-sample={index}
                className="size-3 rounded-tight bg-brand"
                style={{
                  opacity: played ? 1 : 0.2,
                  transition:
                    "opacity var(--dur-slow) var(--ease-out) calc(var(--stagger) * " +
                    index +
                    ")",
                }}
              />
            ))}
          </div>
        </div>
      </Group>

      <Group title={t("showcase.tokens.hairline")}>
        <div className="flex w-full max-w-md flex-col gap-3">
          <div className="hairline-x" data-hairline-sample />
          <div className="h-px w-full bg-border" />
        </div>
      </Group>

      <Group title={t("showcase.tokens.z")}>
        <Table className="max-w-sm">
          <TableHeader>
            <TableRow>
              <TableHead>token</TableHead>
              <TableHead className="text-right">z-index</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(layers ?? []).map(([name, value]) => (
              <TableRow key={name}>
                <TableCell className="font-mono text-caption">{name}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {value}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Group>
    </div>
  );
}
