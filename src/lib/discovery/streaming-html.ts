import { StringDecoder } from "node:string_decoder";
import { Parser } from "htmlparser2";

export type StreamingReferenceLimits = {
  maxNodes: number;
  maxReferences: number;
  maxScripts: number;
  maxInlineConfigBytes: number;
  maxInlineConfigUrls: number;
};

export type RawStreamingReferences = {
  baseHref: string | null;
  scripts: string[];
  resources: string[];
  stylesheets: string[];
  preloads: string[];
  iframes: string[];
  formActions: string[];
  manifests: string[];
  inlineConfigUrls: string[];
  markupMarkers: string[];
  nodesVisited: number;
  nodeLimitReached: boolean;
  referenceLimitReached: boolean;
  scriptReferenceLimitReached: boolean;
  inlineConfigLimitReached: boolean;
};

export type SurfaceLinkReference = { url: string; labelKind: "app_cta" | "auth_cta" | "other" };

const CONFIG_ID =
  /^(?:__(?:app|runtime|public|client|provider)?[-_]?config__|(?:app|runtime|public|client|provider)?[-_]?config)$/i;
const CONFIG_META_KEY =
  /^(?:api[-_]url|api[-_]endpoint|endpoint|dsn|sentry[-_]dsn|base[-_]url|server[-_]url|auth[-_]url|project[-_]url|public[-_]url)$/i;
const MAX_REFERENCE_LENGTH = 2_048;

/**
 * Incremental HTML5-ish tokenizer backed by htmlparser2. It retains only bounded references,
 * one candidate base URL, and capped selected public config text; it never creates a DOM.
 */
export class StreamingHtmlReferenceExtractor {
  private readonly decoder = new StringDecoder("utf8");
  private readonly scripts = new Set<string>();
  private readonly resources = new Set<string>();
  private readonly stylesheets = new Set<string>();
  private readonly preloads = new Set<string>();
  private readonly iframes = new Set<string>();
  private readonly formActions = new Set<string>();
  private readonly manifests = new Set<string>();
  private readonly inlineConfigUrls = new Set<string>();
  private readonly markupMarkers = new Set<string>();
  private readonly surfaceLinks = new Map<string, SurfaceLinkReference["labelKind"]>();
  private readonly parser: Parser;
  private inlineConfigScript = false;
  private inlineConfigBuffer = "";
  private inlineConfigBytes = 0;
  private nodesVisited = 0;
  private baseHref: string | null = null;
  private nodeLimitReached = false;
  private referenceLimitReached = false;
  private scriptReferenceLimitReached = false;
  private inlineConfigLimitReached = false;
  private finished = false;
  private bytesWritten = 0;
  private activeAnchorHref: string | null = null;
  private activeAnchorText = "";
  private insideIgnoredTextTag = false;

  constructor(
    private readonly limits: StreamingReferenceLimits,
    private readonly onInlineConfig: (text: string, target: Set<string>) => boolean,
    private readonly normalizeUrl: (raw: string, baseUrl: string) => string | null,
    private readonly documentUrl: string,
  ) {
    this.parser = new Parser(
      {
        onopentag: (name, attrs) => this.onOpenTag(name, attrs),
        ontext: (text) => this.onText(text),
        onclosetag: (name) => this.onCloseTag(name),
      },
      { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
    );
  }

  write(bytes: Uint8Array) {
    if (this.finished) throw new Error("Cannot write after HTML extraction is finalized.");
    this.bytesWritten += bytes.byteLength;
    if (this.nodeLimitReached) return;
    const decoded = this.decoder.write(bytes);
    if (decoded) this.parser.write(decoded);
  }

  get hasReceivedBytes() {
    return this.bytesWritten > 0;
  }

  finish(documentUrlOverride = this.documentUrl) {
    if (!this.finished) {
      const finalText = this.decoder.end();
      if (finalText) this.parser.write(finalText);
      this.parser.end();
      this.finished = true;
    }
    const baseUrl = this.validBaseUrl(documentUrlOverride);
    const normalize = (values: Set<string>, limit: number) =>
      [
        ...new Set(
          [...values]
            .map((value) => this.normalizeUrl(value, baseUrl))
            .filter((value): value is string => value !== null),
        ),
      ].slice(0, limit);
    return {
      scriptUrls: normalize(this.scripts, this.limits.maxScripts),
      resourceUrls: normalize(this.resources, this.limits.maxReferences),
      stylesheetUrls: normalize(this.stylesheets, this.limits.maxReferences),
      preloadUrls: normalize(this.preloads, this.limits.maxReferences),
      iframeUrls: normalize(this.iframes, this.limits.maxReferences),
      formActionUrls: normalize(this.formActions, this.limits.maxReferences),
      manifestUrls: normalize(this.manifests, 1),
      inlineConfigUrls: [...this.inlineConfigUrls].slice(0, this.limits.maxInlineConfigUrls),
      markupMarkers: [...this.markupMarkers].slice(0, 16),
      surfaceLinks: [...this.surfaceLinks].map(([url, labelKind]) => ({ url, labelKind })),
      nodesVisited: this.nodesVisited,
      nodeLimitReached: this.nodeLimitReached,
      referenceLimitReached: this.referenceLimitReached,
      scriptReferenceLimitReached: this.scriptReferenceLimitReached,
      inlineConfigLimitReached:
        this.inlineConfigLimitReached ||
        this.inlineConfigUrls.size > this.limits.maxInlineConfigUrls,
    };
  }

  private validBaseUrl(documentUrl: string) {
    if (!this.baseHref) return documentUrl;
    const normalized = this.normalizeUrl(this.baseHref, documentUrl);
    return normalized ?? documentUrl;
  }

  private addReference(target: Set<string>, raw: string | undefined, script = false) {
    if (!raw) return;
    if (raw.length > MAX_REFERENCE_LENGTH) {
      this.referenceLimitReached = true;
      return;
    }
    if (script && !this.scripts.has(raw)) {
      if (this.scripts.size >= this.limits.maxScripts) {
        this.scriptReferenceLimitReached = true;
      } else this.scripts.add(raw);
    }
    if (target.has(raw)) return;
    if (this.resources.size >= this.limits.maxReferences) {
      this.referenceLimitReached = true;
      return;
    }
    target.add(raw);
    if (target !== this.resources && this.resources.size < this.limits.maxReferences) {
      this.resources.add(raw);
    }
  }

  private onOpenTag(name: string, attrs: Record<string, string>) {
    this.nodesVisited += 1;
    if (this.nodesVisited > this.limits.maxNodes) {
      this.nodeLimitReached = true;
      this.inlineConfigScript = false;
      this.parser.pause();
      return;
    }
    if (name === "script" || name === "style" || name === "noscript")
      this.insideIgnoredTextTag = true;
    if (name === "base" && this.baseHref === null && attrs.href) this.baseHref = attrs.href;
    if (name === "div" && (attrs.id === "__next" || attrs.id === "__next-build-watcher"))
      this.markupMarkers.add("next-root");
    if (name === "script" && attrs.id === "__NEXT_DATA__")
      this.markupMarkers.add("next-data-script");
    if (name === "a" && attrs.href && this.surfaceLinks.size < 64) {
      this.activeAnchorHref = attrs.href;
      this.activeAnchorText = "";
    }
    if (name === "script") {
      const source = attrs.src;
      const type = (attrs.type ?? "").toLowerCase();
      this.inlineConfigScript =
        !source &&
        ["application/json", "text/json"].includes(type) &&
        (CONFIG_ID.test(attrs.id ?? "") ||
          "data-config" in attrs ||
          attrs["data-purpose"]?.toLowerCase() === "config");
      this.inlineConfigBuffer = "";
      this.inlineConfigBytes = 0;
      if (source) this.addReference(this.resources, source, true);
      return;
    }
    if (name === "link") {
      const rels = new Set((attrs.rel ?? "").toLowerCase().split(/\s+/));
      if (rels.has("manifest")) this.addReference(this.manifests, attrs.href);
      if (rels.has("stylesheet")) this.addReference(this.stylesheets, attrs.href);
      if (
        rels.has("modulepreload") ||
        (rels.has("preload") && attrs.as?.toLowerCase() === "script")
      ) {
        this.addReference(this.resources, attrs.href, true);
        this.addReference(this.preloads, attrs.href);
      } else if (
        ["preload", "prefetch", "preconnect", "dns-prefetch", "icon"].some((rel) => rels.has(rel))
      ) {
        this.addReference(this.resources, attrs.href);
        if (rels.has("preload") || rels.has("prefetch"))
          this.addReference(this.preloads, attrs.href);
      }
      return;
    }
    if (name === "iframe") this.addReference(this.iframes, attrs.src);
    else if (name === "img") this.addReference(this.resources, attrs.src);
    else if (name === "form") this.addReference(this.formActions, attrs.action);
    else if (name === "source") this.addReference(this.resources, attrs.src);
    else if (name === "meta") {
      const key = attrs.name ?? attrs.property ?? "";
      if (
        key.toLowerCase() === "generator" &&
        /^wordpress(?:\s|$)/i.test((attrs.content ?? "").trim())
      ) {
        this.markupMarkers.add("wordpress-generator");
        this.markupMarkers.add("cms-generator-wordpress");
      }
      if (key.toLowerCase() === "generator") {
        const generator = (attrs.content ?? "").trim().toLowerCase();
        for (const cms of ["drupal", "moodle", "joomla", "ghost", "wix"]) {
          if (generator === cms || generator.startsWith(`${cms} `)) {
            this.markupMarkers.add(`cms-generator-${cms}`);
          }
        }
      }
      if (attrs.content && CONFIG_META_KEY.test(key.trim())) {
        this.addInlineUrls(attrs.content);
      }
    }
  }

  private onText(text: string) {
    if (this.activeAnchorHref && !this.insideIgnoredTextTag && this.activeAnchorText.length < 160) {
      this.activeAnchorText += text.slice(0, 160 - this.activeAnchorText.length);
    }
    if (!this.inlineConfigScript || !text) return;
    const bytes = Buffer.byteLength(text, "utf8");
    const remaining = this.limits.maxInlineConfigBytes - this.inlineConfigBytes;
    if (bytes > remaining) {
      this.inlineConfigLimitReached = true;
      this.inlineConfigBuffer += Buffer.from(text, "utf8")
        .subarray(0, Math.max(0, remaining))
        .toString("utf8");
      this.inlineConfigBytes = this.limits.maxInlineConfigBytes;
      this.inlineConfigScript = false;
      return;
    }
    this.inlineConfigBytes += bytes;
    this.inlineConfigBuffer += text;
  }

  private onCloseTag(name: string) {
    if (name === "script" || name === "style" || name === "noscript")
      this.insideIgnoredTextTag = false;
    if (name === "a" && this.activeAnchorHref) {
      const normalized = this.normalizeUrl(this.activeAnchorHref, this.documentUrl);
      if (normalized && !this.surfaceLinks.has(normalized)) {
        const words = this.activeAnchorText
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
        const labelKind =
          /\b(open|launch|go to|visit|use) (the )?(app|product|dashboard|workspace)\b/.test(words)
            ? "app_cta"
            : /\b(sign in|log in|login|authenticate)\b/.test(words)
              ? "auth_cta"
              : "other";
        this.surfaceLinks.set(normalized, labelKind);
      }
      this.activeAnchorHref = null;
      this.activeAnchorText = "";
    }
    if (name !== "script" || !this.inlineConfigScript) return;
    if (this.onInlineConfig(this.inlineConfigBuffer, this.inlineConfigUrls)) {
      this.inlineConfigLimitReached = true;
    }
    this.inlineConfigScript = false;
    this.inlineConfigBuffer = "";
    this.inlineConfigBytes = 0;
  }

  private addInlineUrls(source: string) {
    for (const match of source.matchAll(/https?:\/\/[^\s"'`<>\\]+/gi)) {
      if (this.inlineConfigUrls.size >= this.limits.maxInlineConfigUrls) {
        this.inlineConfigLimitReached = true;
        return;
      }
      const url = this.normalizeUrl(match[0]!.replace(/[),.;]+$/, ""), this.documentUrl);
      if (url) this.inlineConfigUrls.add(url);
    }
  }
}
