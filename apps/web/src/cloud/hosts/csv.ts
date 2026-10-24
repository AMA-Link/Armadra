/**
 * 本地生成 CSV（云端控制台 §3.3.5「导出」）：访问清单在浏览器里拼成文本下载，不发服务端。
 * 值按 RFC 4180 加引号；以 `=` `+` `-` `@` 或制表符开头的值前面补 `'`，免得表格软件把它当公式执行。
 */
const FORMULA = /^[=+\-@\t\r]/;

const QUOTED = new Set(['"', ",", "\r", "\n"]);

function cell(value: string | number | null | undefined): string {
  const text = value == null ? "" : String(value);
  const safe = FORMULA.test(text) ? `'${text}` : text;
  return [...safe].some((char) => QUOTED.has(char))
    ? `"${safe.replaceAll('"', '""')}"`
    : safe;
}

// 表头加数据行，CRLF 分行；开头带 BOM，Excel 才按 UTF-8 打开中文。
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return `\uFEFF${[header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

const BAD_NAME_CHARS = new Set('\\/:*?"<>|');

// 文件名里不能出现的字符换成连字符，空了用 export。
export function csvFileName(name: string, suffix: string): string {
  const base = [...name]
    .map((char) => (BAD_NAME_CHARS.has(char) || char < " " ? "-" : char))
    .join("")
    .replace(/-{2,}/g, "-")
    .trim();
  return `${base === "" ? "export" : base}-${suffix}.csv`;
}

/** 触发浏览器下载（Blob + 临时链接），用完立刻释放。 */
export function downloadCsv(fileName: string, text: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
