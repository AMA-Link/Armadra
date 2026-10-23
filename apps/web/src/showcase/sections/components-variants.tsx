import * as React from "react";
import { Check, Copy, Save, Search } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { AnimatedNumber } from "@/ui/animated-number";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Input } from "@/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { Progress, progressToneFor } from "@/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Shimmer } from "@/ui/shimmer";
import { Spinner } from "@/ui/spinner";
import {
  StatusDot,
  StatusLine,
  StatusPill,
  type StatusTone,
} from "@/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { TextSwap } from "@/ui/text-swap";
import { toast } from "@/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { Tray, TrayCard, TrayHeader, TrayTrend, TrayValue } from "@/ui/tray";

import {
  BADGE_SIZES,
  BADGE_VARIANTS,
  BUTTON_SIZES,
  EDGE_LABELS,
  SESSIONS,
  STATUS_LINES,
  STATUS_TONES,
  TRAY_CARDS,
} from "../fixtures/components";
import { Sample } from "./sample";

/**
 * `components` 分区里设计系统 §9 新增的变体样本：按钮五档与 loading / shortcut、徽标两档
 * 九变体、状态族三形态 × 八 tone、分段控件、卡片三变体与托盘、刻度条、提示五种、
 * 文字替换 / 数字滚动 / 微光。每个变体一格，探针按 `data-sample` 取。
 */

/** 输入类控件的四档（没有 36）。 */
const FIELD_SIZES = ["xs", "sm", "default", "touch"] as const;

const SIZE_ICON = <Save data-icon="inline-start" />;

/** 点一下进入 loading，1.2 秒后收成对勾停 800ms 再恢复（设计系统 §8.5）。 */
function LoadingDemo() {
  const t = useT();
  const [phase, setPhase] = React.useState<"idle" | "loading" | "done">("idle");
  const timers = React.useRef<number[]>([]);
  React.useEffect(
    () => () => timers.current.forEach((timer) => window.clearTimeout(timer)),
    [],
  );
  const run = () => {
    setPhase("loading");
    timers.current.push(
      window.setTimeout(() => setPhase("done"), 1200),
      window.setTimeout(() => setPhase("idle"), 2000),
    );
  };
  return (
    <Button
      variant="outline"
      size="sm"
      loading={phase === "loading"}
      onClick={phase === "idle" ? run : undefined}
    >
      {phase === "done" ? (
        <Spinner size={12} state="done" data-icon="inline-start" />
      ) : (
        <Save data-icon="inline-start" />
      )}
      {t("showcase.sample.save")}
    </Button>
  );
}

/** 「复制」→「已复制」：文字替换，不弹提示。 */
function CopyDemo() {
  const t = useT();
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button variant="outline" size="sm" onClick={() => setCopied(true)}>
      {copied ? (
        <Check data-icon="inline-start" />
      ) : (
        <Copy data-icon="inline-start" />
      )}
      <TextSwap>
        {copied ? t("showcase.sample.copied") : t("showcase.sample.copy")}
      </TextSwap>
    </Button>
  );
}

function RollDemo() {
  const [value, setValue] = React.useState(1284);
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-section font-semibold">
        <AnimatedNumber
          value={value}
          format={(number) =>
            new Intl.NumberFormat().format(Math.round(number))
          }
        />
      </span>
      <Button
        variant="outline"
        size="xs"
        onClick={() => setValue((current) => (current === 1284 ? 9031 : 1284))}
      >
        +
      </Button>
    </div>
  );
}

const TONE_AGENT_LINES = STATUS_LINES;

function StatusFamily() {
  const t = useT();
  const toneLabel = (tone: StatusTone) => t(`showcase.tone.${tone}`);
  return (
    <div className="overflow-x-auto">
      <table
        data-status-family
        className="border-separate border-spacing-x-3 border-spacing-y-2 text-left"
      >
        <thead>
          <tr>
            <th />
            {STATUS_TONES.map((tone) => (
              <th
                key={tone}
                scope="col"
                className="font-mono text-caption font-normal text-muted-foreground"
              >
                {tone}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {([6, 8] as const).map((size) => (
            <tr key={`dot-${size}`}>
              <th
                scope="row"
                className="pr-2 font-mono text-caption font-normal text-muted-foreground"
              >
                dot {size}
              </th>
              {STATUS_TONES.map((tone) => (
                <td key={tone}>
                  <StatusDot tone={tone} size={size} label={toneLabel(tone)} />
                </td>
              ))}
            </tr>
          ))}
          {(["sm", "md"] as const).map((size) => (
            <tr key={`pill-${size}`}>
              <th
                scope="row"
                className="pr-2 font-mono text-caption font-normal text-muted-foreground"
              >
                pill {size}
              </th>
              {STATUS_TONES.map((tone) => (
                <td key={tone}>
                  <StatusPill tone={tone} size={size} label={toneLabel(tone)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VariantSamples() {
  const t = useT();
  const [range, setRange] = React.useState("all");
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-(--space-block)">
      <Sample name="button · sizes" wide>
        <div className="flex items-center gap-2">
          {BUTTON_SIZES.map((size) => (
            <Button key={size} size={size}>
              {SIZE_ICON}
              {t("showcase.sample.save")}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {FIELD_SIZES.map((size) => (
            <Input
              key={size}
              size={size}
              className="w-24"
              aria-label={t("showcase.sample.name")}
              placeholder={t("showcase.sample.search")}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          {FIELD_SIZES.map((size) => (
            <Select key={size} defaultValue="1">
              <SelectTrigger
                size={size}
                className="w-24"
                aria-label={t("showcase.sample.status")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">
                  {t("showcase.sample.option", { n: 1 })}
                </SelectItem>
              </SelectContent>
            </Select>
          ))}
          <InputGroup size="sm" className="w-32">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput aria-label={t("showcase.sample.search")} />
          </InputGroup>
        </div>
      </Sample>
      <Sample name="button · loading · shortcut">
        <Button loading>
          <Save data-icon="inline-start" />
          {t("showcase.sample.save")}
        </Button>
        <Button variant="outline" size="sm" loading>
          <Save data-icon="inline-start" />
          {t("showcase.sample.save")}
        </Button>
        <LoadingDemo />
        <Button shortcut="↵">{t("showcase.sample.send")}</Button>
        <Button variant="outline" size="sm" shortcut="⌘K">
          {t("showcase.sample.search")}
        </Button>
        <Button variant="destructive-solid" shortcut="Esc">
          {t("showcase.sample.delete")}
        </Button>
        <Button variant="outline" size="sm" static>
          {t("showcase.sample.cancel")}
        </Button>
      </Sample>
      <Sample name="badge · sm · md" wide>
        {BADGE_SIZES.map((size) => (
          <div key={size} className="flex w-full flex-wrap items-center gap-2">
            {BADGE_VARIANTS.map((variant) => (
              <Badge key={variant} variant={variant} size={size}>
                {t("showcase.sample.owner")}
              </Badge>
            ))}
          </div>
        ))}
      </Sample>
      <Sample name="status-dot · status-pill" full>
        <StatusFamily />
      </Sample>
      <Sample name="status-line" wide>
        {TONE_AGENT_LINES.map((line) => (
          <StatusLine
            key={line.tone}
            tone={line.tone}
            label={t(`showcase.tone.${line.tone}`)}
            detail={line.detail}
            since={0}
            now={line.seconds * 1000}
            spinning={line.spinning}
            className="w-full"
          />
        ))}
      </Sample>
      <Sample name="tabs · segmented" wide>
        <Tabs value={range} onValueChange={setRange}>
          <TabsList variant="segmented" aria-label={t("showcase.sample.time")}>
            <TabsTrigger value="all">{t("showcase.sample.all")}</TabsTrigger>
            <TabsTrigger value="local">
              {t("showcase.sample.local")}
              <Badge size="sm" variant="secondary">
                3
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="hours">
              {t("showcase.sample.hours")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs defaultValue="all">
          <TabsList
            variant="segmented"
            size="sm"
            aria-label={t("showcase.sample.time")}
          >
            <TabsTrigger value="all">{t("showcase.sample.all")}</TabsTrigger>
            <TabsTrigger value="local">
              {t("showcase.sample.local")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs defaultValue="all">
          <TabsList variant="line" aria-label={t("showcase.sample.time")}>
            <TabsTrigger value="all">{t("showcase.sample.all")}</TabsTrigger>
            <TabsTrigger value="local">
              {t("showcase.sample.local")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Sample>
      <Sample name="progress · ticks" wide>
        <Progress value={62} className="w-full" />
        {[20, 82, 97].map((value) => (
          <div key={value} className="flex w-full items-center gap-3">
            <Progress
              variant="ticks"
              value={value}
              tone={progressToneFor(value)}
              className="flex-1"
            />
            <span className="w-10 text-end font-mono text-meta" data-numeric>
              {value}%
            </span>
          </div>
        ))}
        <Progress className="w-full" />
        <Progress variant="ticks" value={Number.NaN} className="w-full" />
      </Sample>
      <Sample name="card · tray · table" wide>
        <Card className="w-full">
          <CardHeader>
            <CardTitle>{SESSIONS[0].title}</CardTitle>
          </CardHeader>
          <CardContent>{SESSIONS[1].title}</CardContent>
        </Card>
        <Card variant="table" className="w-full">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{t("showcase.sample.session")}</CardTitle>
            <Tabs defaultValue="all">
              <TabsList variant="segmented" size="sm">
                <TabsTrigger value="all">
                  {t("showcase.sample.all")}
                </TabsTrigger>
                <TabsTrigger value="local">
                  {t("showcase.sample.local")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("showcase.sample.session")}</TableHead>
                <TableHead>{t("showcase.sample.status")}</TableHead>
                <TableHead className="text-end">
                  {t("showcase.sample.time")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SESSIONS.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>{session.title}</TableCell>
                  <TableCell>
                    <StatusPill
                      tone={session.tone}
                      label={t(`showcase.tone.${session.tone}`)}
                    />
                  </TableCell>
                  <TableCell className="text-end font-mono tabular-nums">
                    {session.time}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Sample>
      <Sample name="tray" wide>
        <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2">
          {TRAY_CARDS.map((card) => (
            <Tray key={card.id}>
              <TrayHeader label={card.id} />
              <TrayCard>
                <TrayValue
                  label={card.id}
                  value={card.used}
                  format={(value) => `${Math.round(value)}%`}
                />
                <Progress
                  variant="ticks"
                  value={card.used}
                  tone={progressToneFor(card.used)}
                />
                <div className="flex items-center justify-between text-meta text-muted-foreground">
                  <span className="font-mono">
                    {card.window} · {t("showcase.sample.used")}
                  </span>
                  <TrayTrend delta={card.delta} />
                </div>
              </TrayCard>
            </Tray>
          ))}
        </div>
      </Sample>
      <Sample name="toast">
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast.success(t("showcase.sample.save"))}
        >
          success
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            toast.error(t("showcase.sample.alertTitle"), {
              description: t("showcase.sample.alertBody"),
              action: {
                label: t("showcase.sample.retry"),
                onClick: () => undefined,
              },
            })
          }
        >
          error
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast.info(t("showcase.sample.updated"))}
        >
          info
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast.loading(t("showcase.sample.exporting"))}
        >
          loading
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const { result } = toast.promise(
              new Promise<void>((resolve) => setTimeout(resolve, 1200)),
              {
                loading: t("showcase.sample.exporting"),
                success: t("showcase.sample.exported"),
                error: t("showcase.sample.alertTitle"),
              },
            );
            void result.catch(() => undefined);
          }}
        >
          promise
        </Button>
      </Sample>
      <Sample name="text-swap · animated-number · shimmer">
        <CopyDemo />
        <RollDemo />
        <Shimmer className="text-body text-muted-foreground">
          {t("showcase.sample.exporting")}
        </Shimmer>
      </Sample>
      <Sample name="tooltip · shortcut">
        <Tooltip open>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" className="mb-9">
              {t("showcase.sample.search")}
            </Button>
          </TooltipTrigger>
          <TooltipContent shortcut="⌘K" side="bottom">
            {t("showcase.sample.search")}
          </TooltipContent>
        </Tooltip>
      </Sample>
      <Sample name="edge · labels" wide>
        <div className="flex w-40 flex-col gap-1">
          {EDGE_LABELS.map((label) => (
            <Badge
              key={label}
              size="sm"
              variant="outline"
              className="max-w-full justify-start"
            >
              <span className="truncate [overflow-wrap:anywhere]">{label}</span>
            </Badge>
          ))}
        </div>
      </Sample>
    </div>
  );
}
