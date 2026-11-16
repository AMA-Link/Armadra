/**
 * 实时板文档的格式号（`Y.Doc` 的 `meta.boardFormat`）。客户端的格式闸与服务端
 * 种文档时落的号共用这一处：白板线格式 v3（Armadra#952 B5）起是 3，换格式时
 * 只改这里。没有这个键的非空文档来自没有闸的旧客户端，按 {@link LEGACY_BOARD_FORMAT} 算。
 */
export const BOARD_FORMAT = 3;
export const LEGACY_BOARD_FORMAT = 2;
export const BOARD_FORMAT_KEY = "boardFormat";
