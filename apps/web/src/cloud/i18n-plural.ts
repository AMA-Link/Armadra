import { usePreferencesStore } from "@/app/preferences-store";
import { translate, type Locale, type TranslateValues } from "@/i18n";

/** `Intl.PluralRules` 的类别收成两档：`one` 或 `other`（中文恒为 `other`，两条同文）。 */
export function pluralForm(locale: Locale, count: number): "one" | "other" {
  return new Intl.PluralRules(locale).select(count) === "one" ? "one" : "other";
}

/**
 * 复数文案：按 `Intl.PluralRules` 取 `<key>.one` 或 `<key>.other`，`{count}` 自动填。
 * 每个复数键两种语言都写两条。组件里调用时本身已订阅 `useT()`，语言变了会重渲染。
 */
export function tp(
  key: string,
  count: number,
  values: TranslateValues = {},
  locale: Locale = usePreferencesStore.getState().locale,
): string {
  return translate(locale, `${key}.${pluralForm(locale, count)}`, {
    count,
    ...values,
  });
}
