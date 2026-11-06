import * as React from "react";
import { X } from "lucide-react";

import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import { usePreferencesStore, useT } from "../app/preferences-store";
import { useAccess } from "../app/use-access";
import { useCanvasStore } from "../store/canvas-store";
import { SECTION_PAGES } from "./settings/pages";
import { lastInputWasKeyboard } from "./settings/input-modality";
import { useSettingsNavBadges } from "./settings/nav-badges";
import { SettingsPageContext } from "./settings/page-context";
import { SettingsNav } from "./settings/SettingsNav";
import { SettingsSearch } from "./settings/SettingsSearch";
import { SettingsTopbar } from "./settings/SettingsTopbar";
import { useRemoteAccess } from "./settings/remote-access";
import type { SettingsSearchHit } from "./settings/search-index";
import {
  activeSectionId,
  groupSections,
  settingsSection,
  visibleSettingsSections,
} from "./settings/nav";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { IconButton } from "@/ui/icon-button";
import { cn } from "@/lib/cn";
import { Card } from "@/ui/card";
import { ScrollArea } from "@/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { useCompactLayout, usePhoneLandscape } from "@/platform/layout";

/**
 * 弹窗尺寸（设计系统 §2.7）。桌面按视口比例取 `--settings-dialog-w/h`（四周各留
 * 48px，上限 1280 × 860），再夹进视口减 96px 与安全区；平板（768–1023）满宽减 32、
 * 满高减 48。
 */
export const SETTINGS_DIALOG_CLASS = cn(
  "h-[var(--settings-dialog-h)] w-[var(--settings-dialog-w)]",
  "max-h-[calc(100dvh-96px-var(--safe-top)-var(--safe-bottom))]",
  "max-w-[calc(100vw-96px-var(--safe-left)-var(--safe-right))] sm:max-w-[calc(100vw-96px-var(--safe-left)-var(--safe-right))]",
  "max-lg:h-[calc(100dvh-48px-var(--safe-top)-var(--safe-bottom))] max-lg:w-[calc(100vw-32px)]",
  "max-lg:max-w-[calc(100vw-32px)] max-lg:sm:max-w-[calc(100vw-32px)]",
);

/**
 * 手机（竖屏与横屏）铺满整屏（#828）：压过居中弹窗的定位、限宽限高、圆角与边框。
 * 安全区由里面的 `.settings-layout` 自己让（`data-phone`）。
 */
export const SETTINGS_PHONE_CLASS = cn(
  "top-0 left-0 h-[100dvh] max-h-none w-screen max-w-none sm:max-w-none",
  "translate-x-0 translate-y-0 rounded-none border-0 shadow-none",
  // 弹窗外壳是 grid，宽表格（已配对设备）会把轨道撑出屏幕；整屏改成 flex 列。
  "flex flex-col",
);

/** 手机的哪一种形态：竖屏（手机布局）、横屏（电脑布局）或不是手机。 */
type PhoneForm = "portrait" | "landscape" | null;

/** 容器窄于这个宽度（平板与更窄）导航收成 52 的图标栏。 */
const NARROW_WIDTH = 720;

/**
 * 设置工作台（⌘,，设计系统 §5.17）。
 *
 * 大窗（四周各留 48px）：左导航贴在窗口底上，右侧顶栏（面包屑 + 搜索 + 关闭）下面是一块 16 圆角、
 * 1px 边的内容面板，里面是**当前分区独立的一页**——切分区整页替换，没有跨分区
 * 滚动。子页（SSH 主机、自定义 Agent）在同一块面板里推入，面包屑多一级，页头左侧
 * 出现「←」；不叠第二层对话框。手机（竖屏与横屏）铺满整屏、让开安全区（#828）：
 * 竖屏导航收进顶部 `Select`；横屏保留左侧导航列（独立滚动）与紧凑顶栏。
 *
 * ⌘, 打开时没有出场动画（`data-instant`），菜单或按钮打开按对话框出场。
 */
export function SettingsDialog() {
  const t = useT();
  const compact = useCompactLayout();
  const landscape = usePhoneLandscape();
  const phone: PhoneForm = compact
    ? "portrait"
    : landscape
      ? "landscape"
      : null;
  const open = useCanvasStore((state) => state.panels.settings);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const subpage = usePreferencesStore((state) => state.settingsSubpage);
  const closeSubpage = usePreferencesStore((state) => state.setSettingsSubpage);
  const [query, setQuery] = React.useState("");

  // 打开那一刻的输入方式决定要不要出场动画：快捷键打开直接渲染终态。
  const [wasOpen, setWasOpen] = React.useState(open);
  const [instant, setInstant] = React.useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setInstant(lastInputWasKeyboard());
      setQuery("");
    }
  }

  return (
    <ResponsiveDialog
      // 手机不换底部 Sheet（竖屏会离顶 48px），对话框本身铺满整屏。
      sheet={phone === null}
      open={open}
      onOpenChange={(next) => {
        // 关掉设置就丢掉子页：重开时该回到分区页，而不是停在一张表单上。
        if (!next) closeSubpage(null);
        setPanel("settings", next);
      }}
    >
      <ResponsiveDialogContent
        showCloseButton={false}
        instant={instant}
        data-testid="settings-dialog"
        data-phone={phone ?? undefined}
        className={cn(
          "z-[var(--z-dialog)] gap-0 overflow-hidden bg-background p-0 material-backdrop",
          phone ? SETTINGS_PHONE_CLASS : SETTINGS_DIALOG_CLASS,
        )}
        // Esc 先收搜索，再退子页，最后才关弹窗。
        onEscapeKeyDown={(event) => {
          if (query !== "") {
            event.preventDefault();
            setQuery("");
          } else if (subpage) {
            event.preventDefault();
            closeSubpage(null);
          }
        }}
      >
        <ResponsiveDialogTitle className="sr-only">
          {t("settings.title")}
        </ResponsiveDialogTitle>
        <SettingsBody
          compact={compact}
          phone={phone}
          query={query}
          onQueryChange={setQuery}
          onClose={() => setPanel("settings", false)}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** 容器宽度（`ResizeObserver`）；量不到（jsdom）时是 0。 */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** 点中搜索结果后高亮那一行：等页面渲染出带这个标签的行，滚到视野里闪一次。 */
function useRowHighlight(
  container: React.RefObject<HTMLElement | null>,
  target: { label: string; nonce: number } | null,
) {
  React.useEffect(() => {
    if (!target) return;
    let tries = 0;
    let timer = 0;
    let cleanup: (() => void) | undefined;
    const find = () => {
      const root = container.current;
      const row = root
        ? [...root.querySelectorAll<HTMLElement>("[data-settings-label]")].find(
            (node) => node.dataset.settingsLabel === target.label,
          )
        : undefined;
      if (row) {
        row.scrollIntoView?.({ block: "center" });
        row.dataset.highlight = "true";
        const done = () => delete row.dataset.highlight;
        row.addEventListener("animationend", done, { once: true });
        const fallback = window.setTimeout(done, 1500);
        cleanup = () => {
          window.clearTimeout(fallback);
          row.removeEventListener("animationend", done);
          done();
        };
        return;
      }
      tries += 1;
      if (tries < 40) timer = window.setTimeout(find, 50);
    };
    find();
    return () => {
      window.clearTimeout(timer);
      cleanup?.();
    };
  }, [container, target]);
}

function SettingsBody({
  compact,
  phone,
  query,
  onQueryChange,
  onClose,
}: {
  compact: boolean;
  phone: PhoneForm;
  query: string;
  onQueryChange: (value: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const stored = usePreferencesStore((state) => state.lastSettingsSection);
  const remember = usePreferencesStore((state) => state.setLastSettingsSection);
  const subpage = usePreferencesStore((state) => state.settingsSubpage);

  // 成员看不到本机管理的那几页（`nav.ts` 的 `ownerOnly`）；上次停在其中一页
  // 的，回到第一页。
  const { member } = useAccess();
  // 页面的本机 core 不在眼前（经中继、直连 Gateway）：只对眼前这台设备有意义的
  // 那几页不列（`nav.ts` 的 `localOnly`）。打开别人的工作空间不影响设置页。
  const { remote } = useRemoteAccess();
  // 存着的可能是上一版的分区 id（`LEGACY_SECTION_IDS`）：先映射再判断。
  const active = activeSectionId(stored, member, remote);
  const section = settingsSection(active);
  const Page = SECTION_PAGES[active] ?? SECTION_PAGES.defaults!;
  const sections = React.useMemo(
    () => visibleSettingsSections(RUNTIME_VIA_SERVER_SHELL, member, remote),
    [member, remote],
  );
  const groups = React.useMemo(() => groupSections(sections), [sections]);
  const sectionIds = React.useMemo(
    () => sections.map((entry) => entry.id),
    [sections],
  );
  const visible = React.useMemo(() => new Set(sectionIds), [sectionIds]);
  const badges = useSettingsNavBadges(visible);

  const layoutRef = React.useRef<HTMLDivElement>(null);
  const pageRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const narrow = useWidth(layoutRef);
  // 手机横屏不收图标栏：导航是一列能滚的窄栏，标签留着（#828）。
  const isNarrow =
    !compact && phone === null && narrow > 0 && narrow <= NARROW_WIDTH;

  const [highlight, setHighlight] = React.useState<{
    label: string;
    nonce: number;
  } | null>(null);
  useRowHighlight(pageRef, highlight);
  const pick = (hit: SettingsSearchHit) => {
    remember(hit.sectionId);
    onQueryChange("");
    setHighlight(
      hit.rowKey
        ? { label: t(hit.rowKey), nonce: (highlight?.nonce ?? 0) + 1 }
        : null,
    );
  };

  const search = (
    <SettingsSearch
      query={query}
      onQueryChange={onQueryChange}
      sectionIds={sectionIds}
      onPick={pick}
      inputRef={searchRef}
    />
  );

  const context = React.useMemo(
    () => ({ sectionId: active, query }),
    [active, query],
  );

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- 委托容器：⌘F / Ctrl+F 聚焦搜索，不让浏览器的页内查找抢走
    <div
      ref={layoutRef}
      data-narrow={isNarrow ? "true" : undefined}
      data-compact={compact ? "true" : undefined}
      data-phone={phone ?? undefined}
      className={cn(
        "settings-layout flex h-full min-h-0 min-w-0",
        compact ? "flex-col" : "flex-row",
        // 整屏时让开安全区：竖屏的状态栏与主页横条，横屏的刘海一侧与主页横条。
        phone === "portrait" &&
          "px-3 pt-[calc(var(--safe-top)+0.5rem)] pb-[calc(var(--safe-bottom)+0.75rem)]",
        phone === "landscape" &&
          "pr-[var(--safe-right)] pb-[var(--safe-bottom)] pl-[var(--safe-left)]",
      )}
      // ⌘F / Ctrl+F：聚焦顶栏搜索（不让浏览器的页内查找抢走）。
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      }}
    >
      {compact ? (
        <div className="flex shrink-0 flex-col gap-2 pb-2">
          <div className="flex items-center gap-2">
            <Select value={active} onValueChange={remember}>
              <SelectTrigger
                aria-label={t("settings.title")}
                className="min-w-0 flex-1"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {groups.map((group) => (
                  <SelectGroup key={group.groupKey}>
                    <SelectLabel>{t(group.groupKey)}</SelectLabel>
                    {group.sections.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {t(entry.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <IconButton
              size="cluster"
              label={t("tab.close")}
              data-settings-close
              onClick={onClose}
            >
              <X />
            </IconButton>
          </div>
          {search}
        </div>
      ) : (
        <SettingsNav
          groups={groups}
          active={active}
          onSelect={remember}
          badges={badges}
          narrow={isNarrow}
        />
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!compact && (
          <SettingsTopbar
            section={section}
            subpage={subpage}
            search={search}
            onClose={onClose}
          />
        )}

        <Card
          data-slot="settings-panel"
          className={cn(
            "min-h-0 flex-1 gap-0 rounded-float py-0",
            compact ? "" : phone === "landscape" ? "mr-2 mb-2" : "mr-4 mb-4",
          )}
        >
          <ScrollArea className="min-h-0 flex-1">
            <div
              key={subpage ?? active}
              data-testid="settings-page"
              data-section={active}
              data-pushed={subpage ? "true" : undefined}
              ref={pageRef}
              className="settings-page flex flex-col p-(--space-section)"
            >
              {/* 正文列随弹窗变宽：表格页（SSH、快捷键、设备）天然受益。 */}
              <div
                data-slot="settings-column"
                className="flex w-full flex-col gap-(--space-section)"
              >
                <SettingsPageContext.Provider value={context}>
                  <Page />
                </SettingsPageContext.Provider>
              </div>
            </div>
          </ScrollArea>
        </Card>
      </div>
    </div>
  );
}
