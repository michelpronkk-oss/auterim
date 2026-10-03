import "server-only";
import { parse } from "parse5";
import { createHash } from "node:crypto";

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);
const OMIT_TAGS = new Set(["head", "script", "style", "noscript", "template", "svg"]);
export const MAX_NORMALIZED_BYTES = 512 * 1024;

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
};

function visit(node: HtmlNode, output: string[]) {
  const tag = node.tagName ?? node.nodeName;
  if (tag && OMIT_TAGS.has(tag)) return;
  if (tag && BLOCK_TAGS.has(tag)) output.push("\n");
  if (typeof node.value === "string") output.push(node.value);
  for (const child of node.childNodes ?? []) visit(child, output);
  if (node.content) visit(node.content, output);
  if (tag && BLOCK_TAGS.has(tag)) output.push("\n");
}

export function normalizeContent(input: string, isHtml = true): string {
  const lineEnded = input.replace(/\r\n?/g, "\n");
  let plainText = lineEnded;
  if (isHtml) {
    const tree = parse(lineEnded) as unknown as HtmlNode;
    const chunks: string[] = [];
    visit(tree, chunks);
    plainText = chunks.join("");
  }
  const normalized = plainText
    .normalize("NFC")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
  if (Buffer.byteLength(normalized, "utf8") > MAX_NORMALIZED_BYTES) {
    throw new Error("Normalized source exceeded the 512 KiB limit.");
  }
  return normalized;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export type TextDiff = {
  text: string;
  addedLines: number;
  removedLines: number;
  truncated: boolean;
};

const MAX_DIFF_BYTES = 16 * 1024;
const MAX_LCS_CELLS = 1_000_000;

export function deterministicDiff(previous: string, next: string): TextDiff {
  const oldLines = previous ? previous.split("\n") : [];
  const newLines = next ? next.split("\n") : [];
  let addedLines = 0;
  let removedLines = 0;
  let operations: Iterable<string>;
  const cells = (oldLines.length + 1) * (newLines.length + 1);

  if (cells <= MAX_LCS_CELLS) {
    const rows = oldLines.length + 1;
    const cols = newLines.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = oldLines.length - 1; i >= 0; i--) {
      for (let j = newLines.length - 1; j >= 0; j--) {
        const at = i * cols + j;
        table[at] =
          oldLines[i] === newLines[j]
            ? table[(i + 1) * cols + j + 1]! + 1
            : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
      }
    }
    operations = (function* () {
      yield "--- previous";
      yield "+++ current";
      let i = 0;
      let j = 0;
      while (i < oldLines.length || j < newLines.length) {
        if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
          yield ` ${oldLines[i]}`;
          i++;
          j++;
        } else if (
          j < newLines.length &&
          (i === oldLines.length || table[i * cols + j + 1]! >= table[(i + 1) * cols + j]!)
        ) {
          addedLines++;
          yield `+${newLines[j]}`;
          j++;
        } else {
          removedLines++;
          yield `-${oldLines[i]}`;
          i++;
        }
      }
    })();
  } else {
    let prefix = 0;
    while (
      prefix < oldLines.length &&
      prefix < newLines.length &&
      oldLines[prefix] === newLines[prefix]
    )
      prefix++;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    )
      suffix++;
    const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
    const newMiddle = newLines.slice(prefix, newLines.length - suffix);
    removedLines = oldMiddle.length;
    addedLines = newMiddle.length;
    operations = (function* () {
      yield "--- previous";
      yield "+++ current";
      for (const line of oldMiddle) yield `-${line}`;
      for (const line of newMiddle) yield `+${line}`;
    })();
  }

  let text = "";
  let truncated = false;
  let writing = true;
  for (const operation of operations) {
    if (!writing) continue;
    const addition = `${operation}\n`;
    if (Buffer.byteLength(text + addition, "utf8") > MAX_DIFF_BYTES) {
      truncated = true;
      writing = false;
      continue;
    }
    text += addition;
  }
  return { text, addedLines, removedLines, truncated };
}
