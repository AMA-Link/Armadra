/**
 * minisign 分离签名的校验，壳这一侧（issue #288 §2）。
 *
 * 与 `tools/release/minisign.mjs` 是同一种格式、同一套规则的 TypeScript 版本：
 * 只认旧式 `Ed`（签名直接覆盖文件字节），预哈希的 `ED` 按名字拒绝；key id 必须
 * 与内置公钥一致；trusted comment 只有在 global signature 验过之后才可信。
 * 发布流水线（`tools/release/sign.mjs`）给每个资产写 `<资产>.sig`，trusted
 * comment 是 `file:<资产名>`（可能带 ` version:…`），所以这里还要求它点名的就是
 * 被校验的那个文件——同一把钥匙签过的另一个文件的签名，不是这个文件的签名。
 *
 * 不抛异常，失败一律返回原因：下载下来却验不过是一种状态，不是崩溃。
 */

import { createPublicKey, verify } from "node:crypto";

const KEY_ID_BYTES = 8;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
/** 一份签名文件不会比这大；更大的不读。 */
export const SIGNATURE_LIMIT_BYTES = 4 * 1024;

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface MinisignPublicKey {
  keyId: Buffer;
  publicKey: Buffer;
}

export type MinisignFailure =
  | "signatureMalformed"
  | "signatureAlgorithmUnsupported"
  | "signatureKeyMismatch"
  | "signatureMismatch"
  | "trustedCommentMismatch"
  | "signatureForAnotherFile";

export type MinisignVerdict =
  | { ok: true; keyId: string; trustedComment: string }
  | { ok: false; reason: MinisignFailure };

/** 严格 base64：Node 解出来的再编码回去必须与原文一致。 */
function strictBase64(value: string): Buffer | null {
  if (value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim());
}

/** 两行的 minisign 公钥文件；格式不对或不是 `Ed` 就是 `null`。 */
export function parsePublicKey(text: string): MinisignPublicKey | null {
  const [comment, body] = lines(text);
  if (comment === undefined || !comment.startsWith("untrusted comment:")) {
    return null;
  }
  const raw = strictBase64(body ?? "");
  if (raw === null || raw.length !== 2 + KEY_ID_BYTES + PUBLIC_KEY_BYTES) {
    return null;
  }
  if (raw.subarray(0, 2).toString("latin1") !== "Ed") return null;
  return {
    keyId: Buffer.from(raw.subarray(2, 2 + KEY_ID_BYTES)),
    publicKey: Buffer.from(raw.subarray(2 + KEY_ID_BYTES)),
  };
}

/** minisign 显示 key id 的写法：字节倒序的大写十六进制。 */
export function keyIdLabel(keyId: Uint8Array): string {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

/**
 * 用 `publicKeyText` 校验 `signatureText` 是否覆盖 `data`。
 *
 * `fileName` 给出时，trusted comment 必须是 `file:<fileName>` 或以
 * `file:<fileName> ` 开头——发布流水线就是这么写的。
 */
export function verifyDetached(
  publicKeyText: string,
  signatureText: string,
  data: Uint8Array,
  fileName?: string,
): MinisignVerdict {
  const key = parsePublicKey(publicKeyText);
  if (key === null || signatureText.length > SIGNATURE_LIMIT_BYTES) {
    return { ok: false, reason: "signatureMalformed" };
  }
  const [comment, body, trusted, global] = lines(signatureText);
  if (comment === undefined || !comment.startsWith("untrusted comment:")) {
    return { ok: false, reason: "signatureMalformed" };
  }
  const raw = strictBase64(body ?? "");
  if (raw === null || raw.length !== 2 + KEY_ID_BYTES + SIGNATURE_BYTES) {
    return { ok: false, reason: "signatureMalformed" };
  }
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (algorithm === "ED") {
    return { ok: false, reason: "signatureAlgorithmUnsupported" };
  }
  if (algorithm !== "Ed") return { ok: false, reason: "signatureMalformed" };
  if (trusted === undefined || !trusted.startsWith("trusted comment: ")) {
    return { ok: false, reason: "signatureMalformed" };
  }
  const globalSignature = strictBase64(global ?? "");
  if (globalSignature === null || globalSignature.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: "signatureMalformed" };
  }
  const keyId = raw.subarray(2, 2 + KEY_ID_BYTES);
  if (!keyId.equals(key.keyId)) {
    return { ok: false, reason: "signatureKeyMismatch" };
  }
  const signature = raw.subarray(2 + KEY_ID_BYTES);
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, key.publicKey]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, data, publicKey, signature)) {
    return { ok: false, reason: "signatureMismatch" };
  }
  const trustedComment = trusted.slice("trusted comment: ".length);
  const covered = Buffer.concat([
    signature,
    Buffer.from(trustedComment, "utf8"),
  ]);
  if (!verify(null, covered, publicKey, globalSignature)) {
    return { ok: false, reason: "trustedCommentMismatch" };
  }
  if (
    fileName !== undefined &&
    trustedComment !== `file:${fileName}` &&
    !trustedComment.startsWith(`file:${fileName} `)
  ) {
    return { ok: false, reason: "signatureForAnotherFile" };
  }
  return { ok: true, keyId: keyIdLabel(key.keyId), trustedComment };
}
