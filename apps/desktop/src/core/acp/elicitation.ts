/**
 * `elicitation/create` 的两件纯事（契约 §26.1）：Agent 发来的请求收成审批行里
 * 存的那一份，人答的内容按它自己的 `requestedSchema` 校验。
 *
 * 不 import 别的域：审批（`agent/approvals.ts`）与会话层都用它。
 *
 * 表单只认规范允许的扁平类型：字符串（可带 `enum` 或带标题的 `oneOf`）、数、
 * 整数、布尔，以及字符串数组的多选（`items.enum`，或 `items.anyOf` / `oneOf` 的
 * `const` + `title`）。带标题的写法收成 `enum` + `enumNames` 一种，页面与校验只认
 * 这一种。Agent 给了别的形状（嵌套对象、数字数组）时请求照样进审批行，但只能拒绝
 * 或取消：一个页面画不出来的字段，人也就答不了它。
 */

import type {
  AcpElicitationAction,
  AcpElicitationField,
  AcpElicitationParams,
  AcpElicitationResult,
  AcpElicitationSchema,
  AcpElicitationValue,
} from "./types";
import { ACP_ELICITATION_ACTIONS } from "./types";

/** 审批行里一条 elicitation 存的样子（`request_json.elicitation`）。 */
export interface StoredElicitation {
  readonly message: string;
  readonly mode: "form" | "url";
  readonly requestedSchema?: AcpElicitationSchema;
  readonly url?: string;
}

/** 消息与字段说明的上限：只为不让一条请求把审批行撑大。 */
const MESSAGE_LIMIT = 4_000;
const FIELD_LIMIT = 64;
const TEXT_LIMIT = 1_000;
const ENUM_LIMIT = 200;

function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function textOf(value: unknown, limit = TEXT_LIMIT): string | undefined {
  return typeof value === "string" ? clip(value, limit) : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * 带标题的选项（`oneOf` / `anyOf` 里的 `{ const, title }`）收成 `enum` + `enumNames`。
 * 有一项认不出（没有字符串 `const`）就整个答 `undefined`。
 */
function titledOptions(
  raw: unknown,
): { values: string[]; names: string[] } | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const values: string[] = [];
  const names: string[] = [];
  for (const item of raw.slice(0, ENUM_LIMIT)) {
    if (typeof item !== "object" || item === null) return undefined;
    const option = item as Record<string, unknown>;
    if (typeof option.const !== "string") return undefined;
    values.push(clip(option.const, TEXT_LIMIT));
    names.push(clip(textOf(option.title) ?? option.const, TEXT_LIMIT));
  }
  return { values, names };
}

/** 一个字段收成规范的子集；认不出的答 `undefined`（整张表单就答不了）。 */
function fieldOf(raw: unknown): AcpElicitationField | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const field = raw as Record<string, unknown>;
  const common = {
    ...(textOf(field.title) === undefined
      ? {}
      : { title: textOf(field.title) }),
    ...(textOf(field.description) === undefined
      ? {}
      : { description: textOf(field.description) }),
  };
  switch (field.type) {
    case "string": {
      const titled =
        field.oneOf === undefined ? undefined : titledOptions(field.oneOf);
      // 写了 `oneOf` 却认不出：这个字段画不出来，不能当成自由文本放过去。
      if (field.oneOf !== undefined && titled === undefined) return undefined;
      const values =
        titled?.values ??
        (Array.isArray(field.enum)
          ? field.enum
              .filter((item): item is string => typeof item === "string")
              .slice(0, ENUM_LIMIT)
              .map((v) => clip(v, TEXT_LIMIT))
          : undefined);
      const names =
        titled?.names ??
        (Array.isArray(field.enumNames)
          ? field.enumNames
              .filter((item): item is string => typeof item === "string")
              .slice(0, ENUM_LIMIT)
              .map((v) => clip(v, TEXT_LIMIT))
          : undefined);
      return {
        type: "string",
        ...common,
        ...(values === undefined ? {} : { enum: values }),
        ...(names === undefined ? {} : { enumNames: names }),
        ...(textOf(field.format, 40) === undefined
          ? {}
          : { format: textOf(field.format, 40) }),
        ...(finite(field.minLength) === undefined
          ? {}
          : { minLength: finite(field.minLength) }),
        ...(finite(field.maxLength) === undefined
          ? {}
          : { maxLength: finite(field.maxLength) }),
        ...(typeof field.default === "string"
          ? { default: clip(field.default, TEXT_LIMIT) }
          : {}),
      } as AcpElicitationField;
    }
    case "number":
    case "integer":
      return {
        type: field.type,
        ...common,
        ...(finite(field.minimum) === undefined
          ? {}
          : { minimum: finite(field.minimum) }),
        ...(finite(field.maximum) === undefined
          ? {}
          : { maximum: finite(field.maximum) }),
        ...(finite(field.default) === undefined
          ? {}
          : { default: finite(field.default) }),
      } as AcpElicitationField;
    case "boolean":
      return {
        type: "boolean",
        ...common,
        ...(typeof field.default === "boolean"
          ? { default: field.default }
          : {}),
      } as AcpElicitationField;
    case "array": {
      const items =
        typeof field.items === "object" && field.items !== null
          ? (field.items as Record<string, unknown>)
          : undefined;
      if (items === undefined || (items.type ?? "string") !== "string") {
        return undefined;
      }
      const titled = titledOptions(items.anyOf ?? items.oneOf);
      const plain = Array.isArray(items.enum)
        ? items.enum
            .filter((item): item is string => typeof item === "string")
            .slice(0, ENUM_LIMIT)
            .map((v) => clip(v, TEXT_LIMIT))
        : undefined;
      const values = titled?.values ?? plain;
      // 没有选项的数组是自由输入的列表：页面画不出来。
      if (values === undefined || values.length === 0) return undefined;
      const defaults = Array.isArray(field.default)
        ? field.default.filter(
            (item): item is string =>
              typeof item === "string" && values.includes(item),
          )
        : undefined;
      return {
        type: "array",
        ...common,
        items: {
          enum: values,
          ...(titled === undefined ? {} : { enumNames: titled.names }),
        },
        ...(finite(field.minItems) === undefined
          ? {}
          : { minItems: finite(field.minItems) }),
        ...(finite(field.maxItems) === undefined
          ? {}
          : { maxItems: finite(field.maxItems) }),
        ...(defaults === undefined ? {} : { default: defaults }),
      } as AcpElicitationField;
    }
    default:
      return undefined;
  }
}

/**
 * 表单 schema 收成规范子集。字段超过 {@link FIELD_LIMIT} 个、或有一个字段认
 * 不出时答 `undefined`：这张表单只能拒绝或取消。
 */
export function schemaOf(raw: unknown): AcpElicitationSchema | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const schema = raw as Record<string, unknown>;
  if (schema.type !== undefined && schema.type !== "object") return undefined;
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? Object.entries(schema.properties as Record<string, unknown>)
      : [];
  if (properties.length > FIELD_LIMIT) return undefined;
  const fields: Record<string, AcpElicitationField> = {};
  for (const [name, value] of properties) {
    const field = fieldOf(value);
    if (field === undefined) return undefined;
    fields[clip(name, 200)] = field;
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (name): name is string => typeof name === "string" && name in fields,
      )
    : [];
  return {
    type: "object",
    properties: fields,
    ...(required.length === 0 ? {} : { required }),
  };
}

/** Agent 的请求 → 审批行里存的那一份。`_meta` 与未知字段不存。 */
export function storedElicitation(
  params: AcpElicitationParams,
): StoredElicitation {
  const mode = params.mode === "url" ? "url" : "form";
  const schema = mode === "form" ? schemaOf(params.requestedSchema) : undefined;
  return {
    message: clip(String(params.message ?? ""), MESSAGE_LIMIT),
    mode,
    ...(schema === undefined ? {} : { requestedSchema: schema }),
    ...(mode === "url" && typeof params.url === "string"
      ? { url: clip(params.url, 2_000) }
      : {}),
  };
}

/** 审批行的 `request_json` 里那一份；不是 elicitation 答 `undefined`。 */
export function elicitationOf(request: unknown): StoredElicitation | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const raw = request as { protocol?: unknown; elicitation?: unknown };
  if (raw.protocol !== "acp") return undefined;
  const value = raw.elicitation;
  if (typeof value !== "object" || value === null) return undefined;
  const stored = value as Record<string, unknown>;
  return {
    message: typeof stored.message === "string" ? stored.message : "",
    mode: stored.mode === "url" ? "url" : "form",
    ...(stored.requestedSchema === undefined
      ? {}
      : (() => {
          const schema = schemaOf(stored.requestedSchema);
          return schema === undefined ? {} : { requestedSchema: schema };
        })()),
    ...(typeof stored.url === "string" ? { url: stored.url } : {}),
  };
}

export function isElicitationAction(
  value: unknown,
): value is AcpElicitationAction {
  return (
    typeof value === "string" &&
    (ACP_ELICITATION_ACTIONS as readonly string[]).includes(value)
  );
}

function valueFits(
  field: AcpElicitationField,
  value: unknown,
): value is AcpElicitationValue {
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") return false;
      if (field.enum !== undefined && !field.enum.includes(value)) return false;
      if (field.minLength !== undefined && value.length < field.minLength)
        return false;
      if (field.maxLength !== undefined && value.length > field.maxLength)
        return false;
      return value.length <= 8_192;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (field.type === "integer" && !Number.isInteger(value)) return false;
      if (field.minimum !== undefined && value < field.minimum) return false;
      if (field.maximum !== undefined && value > field.maximum) return false;
      return true;
    }
    case "boolean":
      return typeof value === "boolean";
    case "array": {
      if (!Array.isArray(value) || value.length > ENUM_LIMIT) return false;
      if (value.some((item) => typeof item !== "string")) return false;
      if (value.some((item) => !field.items.enum.includes(item as string))) {
        return false;
      }
      if (new Set(value).size !== value.length) return false;
      if (field.minItems !== undefined && value.length < field.minItems) {
        return false;
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/** 一次答复的校验结果：成功时是要交给 Agent 的那一份。 */
export type ElicitationCheck =
  | { readonly ok: true; readonly result: AcpElicitationResult }
  | { readonly ok: false; readonly message: string };

/**
 * 人答的内容按请求自己的 schema 校验：`accept` 要一张能画出来的表单（URL 模式
 * 没有内容），字段只能是 schema 里有的、类型对的，`required` 都在；`decline` /
 * `cancel` 不带内容。
 */
export function checkElicitationAnswer(
  stored: StoredElicitation,
  answer: { readonly action: unknown; readonly content?: unknown },
): ElicitationCheck {
  if (!isElicitationAction(answer.action)) {
    return { ok: false, message: "action must be accept, decline or cancel" };
  }
  if (answer.action !== "accept") {
    if (answer.content !== undefined && answer.content !== null) {
      return { ok: false, message: "content is only sent with accept" };
    }
    return { ok: true, result: { action: answer.action } };
  }
  if (stored.mode === "url") {
    if (answer.content !== undefined && answer.content !== null) {
      return { ok: false, message: "a URL elicitation takes no content" };
    }
    return { ok: true, result: { action: "accept" } };
  }
  const schema = stored.requestedSchema;
  if (schema === undefined) {
    return {
      ok: false,
      message: "this elicitation's form cannot be answered; decline or cancel",
    };
  }
  const content = answer.content ?? {};
  if (
    typeof content !== "object" ||
    content === null ||
    Array.isArray(content)
  ) {
    return { ok: false, message: "content must be an object" };
  }
  const out: Record<string, AcpElicitationValue> = {};
  for (const [name, value] of Object.entries(content)) {
    const field = schema.properties[name];
    if (field === undefined) {
      return { ok: false, message: `${name} is not a field of this form` };
    }
    if (!valueFits(field, value)) {
      return { ok: false, message: `${name} does not fit its field` };
    }
    out[name] = value;
  }
  for (const name of schema.required ?? []) {
    if (!(name in out)) {
      return { ok: false, message: `${name} is required` };
    }
  }
  return { ok: true, result: { action: "accept", content: out } };
}
