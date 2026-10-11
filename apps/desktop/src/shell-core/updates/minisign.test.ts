import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { keyIdLabel, parsePublicKey, verifyDetached } from "./minisign";

/**
 * 测试里现生成的一把 Ed25519 钥匙，按 minisign 的格式写出公钥与签名——与
 * `tools/release/minisign.mjs` 写的字节一致（两行公钥、四行签名）。
 */
function testKey(algorithm = "Ed") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 32);
  const keyId = randomBytes(8);
  const pub = [
    `untrusted comment: minisign public key ${keyIdLabel(keyId)}`,
    Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64"),
    "",
  ].join("\n");
  const signFile = (data: Uint8Array, comment: string) => {
    const signature = sign(null, data, privateKey);
    const global = sign(
      null,
      Buffer.concat([signature, Buffer.from(comment)]),
      privateKey,
    );
    return [
      "untrusted comment: signature from armadra release key",
      Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString(
        "base64",
      ),
      `trusted comment: ${comment}`,
      global.toString("base64"),
      "",
    ].join("\n");
  };
  return { pub, signFile, keyId };
}

const DATA = Buffer.from("Armadra_0.6.0_darwin-aarch64.zip bytes");
const NAME = "Armadra_0.6.0_darwin-aarch64.zip";

describe("verifyDetached", () => {
  it("accepts a signature from the embedded key over these bytes", () => {
    const key = testKey();
    const sig = key.signFile(DATA, `file:${NAME} version:0.6.0`);
    expect(verifyDetached(key.pub, sig, DATA, NAME)).toEqual({
      ok: true,
      keyId: keyIdLabel(key.keyId),
      trustedComment: `file:${NAME} version:0.6.0`,
    });
    // CRLF line endings, as a proxy might rewrite them, still verify.
    expect(
      verifyDetached(key.pub, sig.replace(/\n/g, "\r\n"), DATA, NAME).ok,
    ).toBe(true);
  });

  it("refuses other bytes", () => {
    const key = testKey();
    const sig = key.signFile(DATA, `file:${NAME}`);
    expect(verifyDetached(key.pub, sig, Buffer.from("tampered"), NAME)).toEqual(
      { ok: false, reason: "signatureMismatch" },
    );
  });

  it("refuses a signature by another key", () => {
    const ours = testKey();
    const theirs = testKey();
    const sig = theirs.signFile(DATA, `file:${NAME}`);
    expect(verifyDetached(ours.pub, sig, DATA, NAME)).toEqual({
      ok: false,
      reason: "signatureKeyMismatch",
    });
  });

  it("refuses another key that reuses our key id", () => {
    const ours = testKey();
    const theirs = testKey();
    // Same id, different key material: the id is a hint, not a proof.
    const forged = ours.pub.replace(
      /^untrusted.*\n(.*)\n/,
      (_all, body: string) => {
        const raw = Buffer.from(body, "base64");
        const theirRaw = Buffer.from(theirs.pub.split("\n")[1]!, "base64");
        theirRaw.set(raw.subarray(2, 10), 2);
        return `untrusted comment: x\n${theirRaw.toString("base64")}\n`;
      },
    );
    const sig = ours.signFile(DATA, `file:${NAME}`);
    expect(verifyDetached(forged, sig, DATA, NAME)).toEqual({
      ok: false,
      reason: "signatureMismatch",
    });
  });

  it("refuses an edited trusted comment", () => {
    const key = testKey();
    const sig = key
      .signFile(DATA, `file:${NAME}`)
      .replace(`file:${NAME}`, `file:${NAME} version:9.9.9`);
    expect(verifyDetached(key.pub, sig, DATA, NAME)).toEqual({
      ok: false,
      reason: "trustedCommentMismatch",
    });
  });

  it("refuses a valid signature issued for another file", () => {
    const key = testKey();
    const sig = key.signFile(DATA, "file:SHA256SUMS");
    expect(verifyDetached(key.pub, sig, DATA, NAME)).toEqual({
      ok: false,
      reason: "signatureForAnotherFile",
    });
    // `file:<name>` is a prefix match on a whole token, not on characters.
    const longer = key.signFile(DATA, `file:${NAME}.old`);
    expect(verifyDetached(key.pub, longer, DATA, NAME).ok).toBe(false);
  });

  it("refuses the prehashed algorithm by name", () => {
    const key = testKey("ED");
    const sig = key.signFile(DATA, `file:${NAME}`);
    expect(verifyDetached(key.pub, sig, DATA, NAME)).toEqual({
      ok: false,
      reason: "signatureAlgorithmUnsupported",
    });
  });

  it("refuses malformed files", () => {
    const key = testKey();
    for (const sig of [
      "",
      "untrusted comment: x\nnot base64!\n",
      "untrusted comment: x\nRWQ=\ntrusted comment: x\nAAAA\n",
      "x".repeat(10_000),
    ]) {
      expect(verifyDetached(key.pub, sig, DATA, NAME)).toEqual({
        ok: false,
        reason: "signatureMalformed",
      });
    }
    const sig = key.signFile(DATA, `file:${NAME}`);
    expect(verifyDetached("", sig, DATA, NAME)).toEqual({
      ok: false,
      reason: "signatureMalformed",
    });
  });
});

describe("the committed release key", () => {
  it("is a legacy Ed key with the published id", () => {
    const text = readFileSync(
      new URL("../../../build/armadra-release.pub", import.meta.url),
      "utf8",
    );
    const key = parsePublicKey(text);
    expect(key).not.toBeNull();
    expect(keyIdLabel(key!.keyId)).toBe("A5B7DA4722E242F7");
  });
});
