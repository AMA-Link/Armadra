/**
 * 测试里操作模型弹层（#970）：触发器是 Radix Popover（点击打开），权限与
 * 配置项子菜单是 Radix DropdownMenu（jsdom 里要 pointerDown 才打开）。
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";

/** 操作行上的模型按钮（没有模型目录时它的名字是「思考强度」）。 */
export function modelTrigger(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-slot=acp-model-effort]")!;
}

/** 打开模型弹层，答弹层本身。已开着就直接答。 */
export async function openModelPopover(): Promise<HTMLElement> {
  installDomPolyfills();
  const open = document.querySelector<HTMLElement>(
    "[data-slot=acp-model-popover]",
  );
  if (open) return open;
  const trigger = await waitFor(() => {
    const found = modelTrigger();
    if (!found) throw new Error("no model trigger yet");
    return found;
  });
  fireEvent.click(trigger);
  return screen.findByRole("dialog");
}

/** 弹层里选一个模型。 */
export async function pickModel(name: string | RegExp): Promise<void> {
  const popover = await openModelPopover();
  fireEvent.click(within(popover).getByRole("option", { name }));
}

/** 弹层右栏里选一档思考强度。 */
export async function pickLevel(name: string | RegExp): Promise<void> {
  const popover = await openModelPopover();
  fireEvent.click(within(popover).getByRole("radio", { name }));
}

/** 弹层底栏的权限按钮。 */
export async function permissionsTrigger(): Promise<HTMLElement> {
  const popover = await openModelPopover();
  return popover.querySelector<HTMLElement>("[data-slot=acp-permissions]")!;
}

/** 打开权限菜单读出各模式的名字（按显示顺序），然后收起。 */
export async function modeNames(): Promise<string[]> {
  const trigger = await permissionsTrigger();
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  const items = await screen.findAllByRole("menuitemradio");
  const names = items.map(
    (item) => item.getAttribute("aria-label") ?? item.textContent ?? "",
  );
  fireEvent.keyDown(items[0]!, { key: "Escape" });
  return names;
}

/** 在权限菜单里选一个模式。 */
export async function pickMode(name: string | RegExp): Promise<void> {
  const trigger = await permissionsTrigger();
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name }));
}

/** 右栏里一个 select 配置项：展开它的子菜单再选。 */
export async function pickOption(
  label: string,
  value: string | RegExp,
): Promise<void> {
  const popover = await openModelPopover();
  const row = within(popover).getByRole("button", {
    name: new RegExp(`^${label}:`),
  });
  fireEvent.pointerDown(row, { button: 0, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: value }));
}

/** 右栏里一个 boolean 配置项的开关。 */
export async function optionSwitch(label: string): Promise<HTMLElement> {
  const popover = await openModelPopover();
  return within(popover).getByRole("switch", { name: label });
}

/** 当前权限模式在底栏按钮上的名字。 */
export async function modeLabel(): Promise<string> {
  return (await permissionsTrigger()).textContent ?? "";
}
