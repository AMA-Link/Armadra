import * as React from "react";

/**
 * 设置工作台外壳给页面的上下文：当前分区 id（页头据此取页名）与顶栏搜索框里的文字
 * （快捷键页用它过滤表格）。页面在对话框之外渲染时（展示页、单测）取默认值。
 */
export interface SettingsPageContextValue {
  sectionId: string | null;
  query: string;
}

export const SettingsPageContext =
  React.createContext<SettingsPageContextValue>({ sectionId: null, query: "" });

export function useSettingsPage(): SettingsPageContextValue {
  return React.useContext(SettingsPageContext);
}

/** 顶栏搜索框当前的文字（已去首尾空白）。 */
export function useSettingsQuery(): string {
  return React.useContext(SettingsPageContext).query.trim();
}
