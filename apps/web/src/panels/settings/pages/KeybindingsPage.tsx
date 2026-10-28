import * as React from "react";
import { Ellipsis, Plus, RotateCcw, Trash2 } from "lucide-react";

import type { RuntimeSettingsPatch } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { useAccess } from "../../../app/use-access";
import { toast } from "@/ui/toast";
import {
  COMMANDS,
  COMMAND_BY_ID,
  WHEN_KEYS,
  commandKeys,
  commandWhen,
  formatKeys,
  isWindowShortcut,
  suspendKeybindings,
  useGlobalShortcuts,
  type CommandId,
  type CommandScope,
} from "../../../keybindings";
import { useDeviceKeymapStore } from "../device-keymap-store";
import {
  addChord,
  chordFromEvent,
  currentPlatform,
  emptyKeymap,
  exportKeymap,
  importKeymap,
  keymapConflicts,
  keymapEnabled,
  keymapSource,
  keysBelow,
  otherPlatform,
  removeChord,
  resolveKeymap,
  splitChords,
  whenProblem,
  type KeymapSection,
  type KeymapSource,
  type PlatformName,
} from "../keymap";
import {
  BUILTIN_PROFILE_IDS,
  DEFAULT_PROFILE_ID,
  PROFILE_ID_PATTERN,
  activeProfileId,
  createProfilePatch,
  deleteProfilePatch,
  isBuiltinProfile,
  mergeLayers,
  profileLayersPatch,
  profilePatch,
  profilePreset,
  selectProfilePatch,
  storedProfiles,
} from "../keymap-profiles";
import { useSettingsQuery } from "../page-context";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsLoadable } from "../SettingsLoadable";
import { SettingsPageHeader } from "../SettingsPageHeader";
import { SettingsRow } from "../SettingsRow";
import { SettingsTableCard } from "../SettingsTableCard";
import { useRuntimeSettings } from "../use-runtime-settings";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Kbd } from "@/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { Textarea } from "@/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { isDesktop } from "@/platform";

const SCOPES: readonly CommandScope[] = [
  "app",
  "canvas",
  "terminal",
  "editor",
  "browser",
  "scm",
  "global",
];

/** 表格筛选：全部 / 已改（本设备或全局层有覆盖）/ 未绑定。 */
type KeymapFilter = "all" | "changed" | "unbound";

/** 录制写到哪一层。默认写全局：多数人只有一套键位，换台机器还想要它。 */
type WriteLayer = "global" | "device";

/**
 * 正在录哪一条、录完怎么写：`replace` 整条换成这一组，`append` 加在末尾成为
 * 又一组替代键。
 */
interface Recording {
  id: CommandId;
  mode: "replace" | "append";
}

/**
 * 设置 → 快捷键（§24.1；终端宿主设计 §10）。
 *
 * 三层：内置默认（按 mac / other 分平台）→ 用户全局覆盖（Runtime settings，
 * 跨设备）→ 本设备覆盖（localStorage，按设备 id）。每行左边写清这条键位现在
 * 由哪一层决定，右边的 ↺ 只重置**最上面那一层**，落回下一层——一路点回默认。
 *
 * 点键位进入录制态：下一个带修饰键的组合就是新键位，Esc 取消，Backspace 重置
 * 当前层。录制只写当前平台那一格；另一个平台可以切过去看，但不能在这台机器上
 * 录——抓到的是本机的物理按键，替另一个平台猜是错的。
 *
 * 每行的「更多」菜单：再录一组替代键、移除其中一组、设为无（一条空串覆盖，
 * 与「没覆盖」不同，↺ 能把它撤回），以及编辑这一条的 `when` 条件。
 *
 * 冲突跑在三层合并之后的结果上，不自动改判谁赢：用户看得见才改得动。
 */
export function KeybindingsPage() {
  const t = useT();
  // 本设备那一层存在 localStorage，谁都能改；全局那一层（档、用户覆盖）写的
  // 是主机设置，只有 owner 读得到也写得进（§2.1）。成员只看见本设备层。
  const { member } = useAccess();
  const { settings, save: runtimeSave } = useRuntimeSettings({
    enabled: !member,
    scope: "local",
  });
  const save = React.useMemo(
    () => ({
      mutate: (patch: RuntimeSettingsPatch) => {
        if (!member) runtimeSave.mutate(patch);
      },
    }),
    [member, runtimeSave],
  );
  const device = useDeviceKeymapStore((state) => state.keymap);
  const setDeviceChord = useDeviceKeymapStore((state) => state.setChord);
  const clearDeviceChord = useDeviceKeymapStore((state) => state.clearChord);
  const replaceDevice = useDeviceKeymapStore((state) => state.replace);
  const clearDevice = useDeviceKeymapStore((state) => state.clearAll);

  const raw = settings.data?.keymap;
  const enabled = keymapEnabled(raw);
  const profiles = React.useMemo(() => storedProfiles(raw), [raw]);
  const profile = React.useMemo(() => activeProfileId(raw), [raw]);
  const preset = React.useMemo(() => profilePreset(profile), [profile]);
  const user = profiles[profile] ?? emptyKeymap();
  // 「全局」那一层 = 这个档的预设 + 用户在这个档里的修改。
  const global = React.useMemo(() => mergeLayers(preset, user), [preset, user]);
  const here = currentPlatform();
  const [platform, setPlatform] = React.useState<PlatformName>(here);
  const [chosenLayer, setLayer] = React.useState<WriteLayer>("global");
  const layer: WriteLayer = member ? "device" : chosenLayer;
  const [recording, setRecording] = React.useState<Recording | null>(null);
  const [editingWhen, setEditingWhen] = React.useState<{
    id: CommandId;
    text: string;
  } | null>(null);
  const [transfer, setTransfer] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<KeymapFilter>("all");
  // 顶栏搜索也过滤这张表
  const query = useSettingsQuery();
  const [naming, setNaming] = React.useState<string | null>(null);
  // 壳最后一次向系统注册全局热键的结果。空表就是「这一轮什么也没确认」，
  // 那时不写任何徽标，而不是写「已生效」。
  const registered = useGlobalShortcuts((store) => store.outcomes);

  const keymap = React.useMemo(
    () => resolveKeymap(global, device),
    [global, device],
  );
  const conflicts = React.useMemo(
    () => keymapConflicts(keymap, platform === "mac"),
    [keymap, platform],
  );
  // 只能录当前平台：另一个平台是只读预览。
  const preview = platform !== here;

  /** 写一格：当前平台的键位（`section` 缺省），或不分平台的 `when`。 */
  const write = React.useCallback(
    (id: CommandId, value: string, section: KeymapSection = here) => {
      if (layer === "device") setDeviceChord(section, id, value);
      // 写进**当前档**，不是写进一张全局表：换个档回来，改的还在。
      else
        save.mutate({
          keymap: profilePatch(profile, section, { [id]: value }),
        });
    },
    [layer, here, profile, save, setDeviceChord],
  );

  /** 重置到上一层：本设备 → 这个档里自己的修改 → 档预设 / 内置默认。 */
  const resetOne = React.useCallback(
    (id: CommandId, section: KeymapSection = here) => {
      const source = keymapSource(id, section, global, device, preset);
      if (source === "device") clearDeviceChord(section, id);
      else if (source === "global")
        save.mutate({ keymap: profilePatch(profile, section, { [id]: null }) });
    },
    [here, global, device, preset, profile, clearDeviceChord, save],
  );

  /** 这台机器上这条命令现在生效的那几组键（录制与增删都以它为底）。 */
  const keysHere = React.useCallback(
    (id: CommandId) => commandKeys(id, { keymap, mac: here === "mac" }),
    [keymap, here],
  );

  const resetAll = React.useCallback(() => {
    clearDevice();
    // 只清这个档里用户自己改过的那些；预设不是覆盖，清不掉也不该清。
    const cleared: Record<string, Record<string, null>> = {};
    for (const [name, layerMap] of Object.entries(user))
      cleared[name] = Object.fromEntries(
        Object.keys(layerMap).map((id) => [id, null]),
      );
    // 条件那一格没改过就不带：平台两格照旧总是带上，形状与从前一致。
    if (Object.keys(cleared.when ?? {}).length === 0) delete cleared.when;
    if (Object.values(cleared).some((entry) => Object.keys(entry).length > 0))
      save.mutate({ keymap: profileLayersPatch(profile, cleared) });
  }, [clearDevice, user, profile, save]);

  const chooseProfile = React.useCallback(
    (id: string) => save.mutate({ keymap: selectProfilePatch(id) }),
    [save],
  );

  const createProfile = React.useCallback(
    (name: string) => {
      const id = name.trim().toLowerCase().replace(/\s+/g, "-");
      if (!PROFILE_ID_PATTERN.test(id) || id in profiles) {
        toast.error(t("settings.shortcut.profile.invalid"));
        return;
      }
      // 新档从内置默认起步，一条覆盖都没有——「自定义」就该是空白的。
      save.mutate({ keymap: createProfilePatch(id) });
      setNaming(null);
    },
    [profiles, save, t],
  );

  const removeProfile = React.useCallback(() => {
    const patch = deleteProfilePatch(profile, profile);
    if (patch) save.mutate({ keymap: patch });
  }, [profile, save]);

  // 录制期间在捕获阶段独占键盘，否则按下的组合会先被应用自己的快捷键吃掉。
  React.useEffect(() => {
    if (!recording) return;
    const resume = suspendKeybindings();
    const onKeyDown = (event: KeyboardEvent) => {
      if (isWindowShortcut(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      if (event.key === "Backspace") {
        resetOne(recording.id);
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(event);
      if (!chord) return;
      write(
        recording.id,
        recording.mode === "append"
          ? addChord(keysHere(recording.id), chord, here === "mac")
          : chord,
      );
      setRecording(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      resume();
    };
  }, [recording, write, resetOne, keysHere, here]);

  const whenCheck = editingWhen ? whenProblem(editingWhen.text) : null;

  function saveWhen() {
    if (!editingWhen || whenProblem(editingWhen.text)) return;
    write(editingWhen.id, editingWhen.text.trim(), "when");
    setEditingWhen(null);
  }

  function applyImport(text: string) {
    let imported;
    try {
      imported = importKeymap(text);
    } catch {
      toast.error(t("settings.shortcut.import.invalid"));
      return;
    }
    replaceDevice(imported.device);
    // 导入是整层替换：每个档现有的覆盖先删干净，否则文件里没有的条目会留下来。
    const keymap: Record<string, unknown> = { profile: imported.profile };
    const inProfiles: Record<string, unknown> = {};
    for (const [id, existing] of Object.entries(profiles)) {
      const wanted = imported.profiles[id];
      const cleared: Record<string, Record<string, string | null>> = {};
      for (const [name, layerMap] of Object.entries(existing))
        cleared[name] = Object.fromEntries(
          Object.keys(layerMap).map((command) => [command, null]),
        );
      for (const [name, layerMap] of Object.entries(wanted ?? {}))
        cleared[name] = { ...(cleared[name] ?? {}), ...layerMap };
      Object.assign(
        id === DEFAULT_PROFILE_ID ? keymap : inProfiles,
        id === DEFAULT_PROFILE_ID ? cleared : { [id]: cleared },
      );
    }
    // 文件里带来的、本机还没有的档，整份写进去。
    for (const [id, layers] of Object.entries(imported.profiles))
      if (id !== DEFAULT_PROFILE_ID && !(id in profiles))
        inProfiles[id] = layers;
    if (Object.keys(inProfiles).length > 0) keymap.profiles = inProfiles;
    save.mutate({ keymap });
    setTransfer(null);
  }

  /** 重置按钮的名字：说清会落到哪个键位，不然「上一层」只是个说法。 */
  const resetLabel = (
    command: (typeof COMMANDS)[number],
    below: string | null,
    mac: boolean,
  ) =>
    t("settings.shortcut.reset", {
      command: t(command.labelKey),
      keys: formatKeys(below, { mac }) || t("settings.shortcut.unbound"),
    });

  const visibleScopes = SCOPES.filter(
    // 全局热键要靠桌面壳去向系统注册；浏览器里连能不能注册都无从谈起，
    // 显示一组按了没反应的键位比不显示更糟。
    (scope) => scope !== "global" || isDesktop(),
  );
  const mac = platform === "mac";
  const needle = query.toLocaleLowerCase();
  const entries = visibleScopes.map((scope) => ({
    scope,
    rows: COMMANDS.filter((command) => command.scope === scope).flatMap(
      (command) => {
        const source: KeymapSource = keymapSource(
          command.id,
          platform,
          global,
          device,
          preset,
        );
        const keys = commandKeys(command.id, { keymap, mac });
        const chords = splitChords(keys);
        if (
          filter === "changed" &&
          (source === "default" || source === "profile")
        )
          return [];
        if (filter === "unbound" && chords.length > 0) return [];
        if (needle !== "") {
          const text = [
            t(command.labelKey),
            ...chords.map((chord) => formatKeys(chord, { mac })),
          ]
            .join(" ")
            .toLocaleLowerCase();
          if (!text.includes(needle)) return [];
        }
        return [{ command, source, chords }];
      },
    ),
  }));
  const rowCount = entries.reduce(
    (total, entry) => total + entry.rows.length,
    0,
  );

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            {member ? null : (
              <>
                <Select value={profile} onValueChange={chooseProfile}>
                  <SelectTrigger
                    aria-label={t("settings.shortcut.profile")}
                    size="sm"
                    className="w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(profiles)
                      .sort(
                        (left, right) =>
                          Number(!isBuiltinProfile(left)) -
                            Number(!isBuiltinProfile(right)) ||
                          left.localeCompare(right),
                      )
                      .map((id) => (
                        <SelectItem key={id} value={id}>
                          {isBuiltinProfile(id)
                            ? t(`settings.shortcut.profile.${id}`)
                            : id}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconButton
                      size="cluster"
                      label={t("settings.shortcut.profile.create")}
                      onClick={() => setNaming("")}
                    >
                      <Plus />
                    </IconButton>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("settings.shortcut.profile.create")}
                  </TooltipContent>
                </Tooltip>
                {!isBuiltinProfile(profile) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <IconButton
                        size="cluster"
                        label={t("settings.shortcut.profile.delete")}
                        onClick={removeProfile}
                      >
                        <Trash2 />
                      </IconButton>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("settings.shortcut.profile.delete")}
                    </TooltipContent>
                  </Tooltip>
                )}
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setTransfer(
                  exportKeymap(
                    profiles[DEFAULT_PROFILE_ID] ?? emptyKeymap(),
                    device,
                    profiles,
                    profile,
                  ),
                )
              }
            >
              {t("settings.shortcut.transfer")}
            </Button>
            <Button variant="outline" size="sm" onClick={resetAll}>
              {t("settings.shortcut.resetAll")}
            </Button>
          </>
        }
      />

      <SettingsLoadable
        grouped
        loading={settings.isLoading}
        rows={3}
        control="select"
      >
        <SettingsGroup>
          {member ? null : (
            <>
              {/* 总开关（契约 §66）。重新打开时删掉这个键，回到缺省。 */}
              <SettingsRow label={t("settings.shortcut.enabled")}>
                <Switch
                  checked={enabled}
                  aria-label={t("settings.shortcut.enabled")}
                  onCheckedChange={(next) =>
                    save.mutate({ keymap: { enabled: next ? null : false } })
                  }
                />
              </SettingsRow>
              <SettingsRow label={t("settings.shortcut.layer")}>
                <Select
                  value={layer}
                  onValueChange={(value) => setLayer(value as WriteLayer)}
                >
                  <SelectTrigger
                    aria-label={t("settings.shortcut.layer")}
                    size="sm"
                    className="w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">
                      {t("settings.shortcut.source.global")}
                    </SelectItem>
                    <SelectItem value="device">
                      {t("settings.shortcut.source.device")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </SettingsRow>
            </>
          )}
          <SettingsRow label={t("settings.shortcut.platform")}>
            <Select
              value={platform}
              onValueChange={(value) => setPlatform(value as PlatformName)}
            >
              <SelectTrigger
                aria-label={t("settings.shortcut.platform")}
                size="sm"
                className="w-40"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={here}>
                  {t(`settings.shortcut.platform.${here}`)}
                </SelectItem>
                <SelectItem value={otherPlatform(here)}>
                  {t(`settings.shortcut.platform.${otherPlatform(here)}`)}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsGroup>

        <SettingsTableCard<KeymapFilter>
          title={t("settings.section.keybindings")}
          loading={settings.isLoading}
          skeleton={{ rows: 6, columns: 5 }}
          empty={
            rowCount === 0 ? { title: t("settings.shortcut.empty") } : null
          }
          filter={{
            value: filter,
            onValueChange: setFilter,
            label: t("settings.section.keybindings"),
            options: [
              { value: "all", label: t("settings.shortcut.filter.all") },
              {
                value: "changed",
                label: t("settings.shortcut.filter.changed"),
              },
              { value: "unbound", label: t("settings.shortcut.unbound") },
            ],
          }}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.shortcut.col.command")}</TableHead>
                <TableHead>{t("settings.shortcut.col.keys")}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t("settings.shortcut.col.source")}
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("settings.shortcut.when")}
                </TableHead>
                <TableHead>
                  <span className="sr-only">
                    {t("settings.shortcut.col.actions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries
                .filter((entry) => entry.rows.length > 0)
                .map((entry) => (
                  <React.Fragment key={entry.scope}>
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={5}
                        className="text-caption font-medium text-muted-foreground"
                      >
                        {t(`settings.scope.${entry.scope}`)}
                      </TableCell>
                    </TableRow>
                    {entry.rows.map(({ command, source, chords }) => {
                      const below =
                        source === "default" || source === "profile"
                          ? null
                          : keysBelow(
                              command.id,
                              platform,
                              source,
                              global,
                              preset,
                            );
                      const when = commandWhen(command.id, keymap);
                      const active =
                        recording?.id === command.id ? recording.mode : null;
                      return (
                        <TableRow key={command.id} data-command={command.id}>
                          <TableCell>
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              {t(command.labelKey)}
                              {conflicts.has(command.id) && (
                                <Badge variant="destructive" size="sm">
                                  {t("settings.shortcut.conflict")}
                                </Badge>
                              )}
                              {/*
                               * 被别的程序占住的组合键在这里说明白。设置里写着一个键、
                               * 按下去却什么也不发生，是这一组最容易出现的问题。
                               */}
                              {(registered[command.id] === "taken" ||
                                registered[command.id] === "invalid") && (
                                <Badge variant="destructive" size="sm">
                                  {t(
                                    `settings.shortcut.global.${registered[command.id]}`,
                                  )}
                                </Badge>
                              )}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="xs"
                              data-roving-item
                              data-recording={active !== null}
                              aria-label={t(command.labelKey)}
                              disabled={preview}
                              className="-ml-1.5 gap-1 data-[recording=true]:bg-muted"
                              onClick={() =>
                                setRecording((current) =>
                                  current?.id === command.id
                                    ? null
                                    : { id: command.id, mode: "replace" },
                                )
                              }
                            >
                              {active === "replace" ? (
                                <span className="text-caption text-muted-foreground">
                                  {t("settings.shortcut.recording")}
                                </span>
                              ) : chords.length === 0 ? (
                                <Kbd persistent>
                                  {t("settings.shortcut.unbound")}
                                </Kbd>
                              ) : (
                                chords.map((chord, position) => (
                                  <Kbd persistent key={`${position}:${chord}`}>
                                    {formatKeys(chord, { mac })}
                                  </Kbd>
                                ))
                              )}
                              {active === "append" && (
                                <span className="text-caption text-muted-foreground">
                                  {t("settings.shortcut.recording")}
                                </span>
                              )}
                            </Button>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            <Badge variant="outline" size="sm">
                              {t(`settings.shortcut.source.${source}`)}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            {when && (
                              <code
                                title={when}
                                className="block max-w-48 truncate font-mono text-caption text-muted-foreground"
                              >
                                {when}
                              </code>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              {!preview && (
                                <DropdownMenu>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <DropdownMenuTrigger asChild>
                                        <IconButton
                                          size="inline"
                                          label={t("settings.shortcut.more", {
                                            command: t(command.labelKey),
                                          })}
                                        >
                                          <Ellipsis />
                                        </IconButton>
                                      </DropdownMenuTrigger>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {t("settings.shortcut.more", {
                                        command: t(command.labelKey),
                                      })}
                                    </TooltipContent>
                                  </Tooltip>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem
                                      onSelect={() =>
                                        setRecording({
                                          id: command.id,
                                          mode: "append",
                                        })
                                      }
                                    >
                                      {t("settings.shortcut.add")}
                                    </DropdownMenuItem>
                                    {chords.length > 1 &&
                                      chords.map((chord, position) => (
                                        <DropdownMenuItem
                                          key={`${position}:${chord}`}
                                          onSelect={() =>
                                            write(
                                              command.id,
                                              removeChord(
                                                keysHere(command.id),
                                                position,
                                              ),
                                            )
                                          }
                                        >
                                          {t("settings.shortcut.removeOne", {
                                            keys: formatKeys(chord, { mac }),
                                          })}
                                        </DropdownMenuItem>
                                      ))}
                                    {chords.length > 0 && (
                                      <DropdownMenuItem
                                        onSelect={() => write(command.id, "")}
                                      >
                                        {t("settings.shortcut.clear")}
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      onSelect={() =>
                                        setEditingWhen({
                                          id: command.id,
                                          text: when ?? "",
                                        })
                                      }
                                    >
                                      {t("settings.shortcut.when.edit")}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                              {source !== "default" &&
                                source !== "profile" &&
                                !preview && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <IconButton
                                        size="inline"
                                        label={resetLabel(command, below, mac)}
                                        onClick={() => resetOne(command.id)}
                                      >
                                        <RotateCcw />
                                      </IconButton>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {resetLabel(command, below, mac)}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </React.Fragment>
                ))}
            </TableBody>
          </Table>
        </SettingsTableCard>
      </SettingsLoadable>

      <ResponsiveDialog
        open={editingWhen !== null}
        onOpenChange={(open) => !open && setEditingWhen(null)}
      >
        <ResponsiveDialogContent className="sm:max-w-[460px]">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {editingWhen &&
                t("settings.shortcut.when.title", {
                  command: t(COMMAND_BY_ID[editingWhen.id].labelKey),
                })}
            </ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <Input
            aria-label={t("settings.shortcut.when")}
            aria-invalid={whenCheck !== null}
            className="font-mono text-meta"
            spellCheck={false}
            autoFocus
            value={editingWhen?.text ?? ""}
            onChange={(event) => {
              const text = event.target.value;
              setEditingWhen((current) => current && { ...current, text });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveWhen();
            }}
          />
          {whenCheck && (
            <p role="alert" className="text-body text-danger-text">
              {whenCheck.problem === "syntax"
                ? t("settings.shortcut.when.syntax")
                : t("settings.shortcut.when.unknown", {
                    keys: whenCheck.keys.join(", "),
                    known: WHEN_KEYS.join(", "),
                  })}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {editingWhen &&
              keymapSource(editingWhen.id, "when", global, device) !==
                "default" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mr-auto"
                  onClick={() => {
                    resetOne(editingWhen.id, "when");
                    setEditingWhen(null);
                  }}
                >
                  {t("settings.shortcut.when.reset")}
                </Button>
              )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditingWhen(null)}
            >
              {t("settings.shortcut.transfer.close")}
            </Button>
            <Button size="sm" disabled={whenCheck !== null} onClick={saveWhen}>
              {t("settings.shortcut.when.save")}
            </Button>
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <ResponsiveDialog
        open={naming !== null}
        onOpenChange={(open) => !open && setNaming(null)}
      >
        <ResponsiveDialogContent className="sm:max-w-[420px]">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t("settings.shortcut.profile.create")}
            </ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <Input
            aria-label={t("settings.shortcut.profile.create")}
            value={naming ?? ""}
            autoFocus
            onChange={(event) => setNaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") createProfile(naming ?? "");
            }}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setNaming(null)}>
              {t("settings.shortcut.transfer.close")}
            </Button>
            <Button size="sm" onClick={() => createProfile(naming ?? "")}>
              {t("settings.shortcut.profile.create")}
            </Button>
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <ResponsiveDialog
        open={transfer !== null}
        onOpenChange={(open) => !open && setTransfer(null)}
      >
        <ResponsiveDialogContent className="sm:max-w-[520px]">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t("settings.shortcut.transfer")}
            </ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <Textarea
            aria-label={t("settings.shortcut.transfer")}
            className="h-56 font-mono text-meta"
            spellCheck={false}
            value={transfer ?? ""}
            onChange={(event) => setTransfer(event.target.value)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTransfer(null)}
            >
              {t("settings.shortcut.transfer.close")}
            </Button>
            <Button size="sm" onClick={() => applyImport(transfer ?? "")}>
              {t("settings.shortcut.import.apply")}
            </Button>
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}
