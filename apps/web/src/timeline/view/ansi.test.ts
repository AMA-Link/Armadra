import { describe, expect, it } from "vitest";
import { ansi256, parseAnsi } from "./ansi";

describe("parseAnsi", () => {
  it("passes plain text through as one span", () => {
    expect(parseAnsi("hello")).toEqual([{ text: "hello" }]);
  });

  it("colors with 16 colors and resets", () => {
    const spans = parseAnsi("\u001b[31mred\u001b[0m plain");
    expect(spans).toHaveLength(2);
    expect(spans[0]?.fg).toBeDefined();
    expect(spans[0]?.text).toBe("red");
    expect(spans[1]).toEqual({ text: " plain" });
  });

  it("supports bright, background and attributes", () => {
    const [span] = parseAnsi("\u001b[1;4;92;41mx\u001b[0m");
    expect(span).toMatchObject({ text: "x", bold: true, underline: true });
    expect(span?.fg).toBeDefined();
    expect(span?.bg).toBeDefined();
  });

  it("supports 256 colors: cube and grayscale", () => {
    expect(ansi256(16)).toBe("#000000");
    expect(ansi256(231)).toBe("#ffffff");
    expect(ansi256(232)).toBe("#080808");
    expect(ansi256(300)).toBeUndefined();
    const [span] = parseAnsi("\u001b[38;5;196mx");
    expect(span?.fg).toBe(ansi256(196));
  });

  it("reads true color params without coloring and keeps parsing", () => {
    const spans = parseAnsi("\u001b[38;2;10;20;30;1mx");
    expect(spans[0]).toMatchObject({ text: "x", bold: true });
    expect(spans[0]?.fg).toBeUndefined();
  });

  it("drops other control sequences and keeps the last carriage-return write", () => {
    expect(parseAnsi("\u001b[2K\u001b[1Aok")).toEqual([{ text: "ok" }]);
    expect(parseAnsi("10%\r50%\r100%\ndone")).toEqual([{ text: "100%\ndone" }]);
    expect(parseAnsi("\u001b]0;title\u0007body")).toEqual([{ text: "body" }]);
  });

  it("merges adjacent spans with identical style", () => {
    expect(parseAnsi("a\u001b[39mb")).toEqual([{ text: "ab" }]);
  });
});
