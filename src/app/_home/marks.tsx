import { providerLogos } from "./provider-logos";
import s from "./home.module.css";

const round = (n: number) => +n.toFixed(2);

/** Auterim mark: an arch with an inset counter and a curved base bar (from the v3 design). */
const brandGeometry = (() => {
  const ay = 6,
    hw = 26,
    by = 50,
    arch = 5,
    d = 12,
    gap = 5,
    thick = 3.2;
  const h = by - ay,
    c = Math.hypot(hw, h),
    r = (hw * h) / (hw + c),
    iy = by - r,
    k = (r - d) / r,
    sh = ((d * arch) / r) * 1.1;
  const t = (x: number, y: number) => [round(32 + (x - 32) * k), round(iy + (y - iy) * k - sh)];
  const A = t(32, ay),
    B = t(32 + hw, by),
    C = t(32 - hw, by),
    Q = t(32, by - 2 * arch);
  const y = by + gap,
    bw = hw * 0.85,
    cy = y - 2 * arch * 0.9;
  return {
    arch: `M32 ${ay}L${32 + hw} ${by}Q32 ${by - 2 * arch} ${32 - hw} ${by}ZM${A[0]} ${A[1]}L${B[0]} ${B[1]}Q${Q[0]} ${Q[1]} ${C[0]} ${C[1]}Z`,
    bar: `M${round(32 - bw)} ${y}Q32 ${round(cy)} ${round(32 + bw)} ${y}Q32 ${round(cy + 2 * thick)} ${round(32 - bw)} ${y}Z`,
    viewBox: `0 ${round((ay + y) / 2 - 32)} 64 64`,
  };
})();

export function BrandMark({
  size,
  tone = "light",
  className,
}: {
  size: number;
  tone?: "light" | "dark";
  className?: string;
}) {
  const ink = tone === "dark" ? "#F3EEE3" : "#0E1B2E";
  const accent = tone === "dark" ? "#4F7DF3" : "#2F5BD8";
  return (
    <svg
      width={size}
      height={size}
      viewBox={brandGeometry.viewBox}
      aria-hidden="true"
      className={className}
    >
      <path d={brandGeometry.arch} fill={ink} fillRule="evenodd" />
      <path d={brandGeometry.bar} fill={accent} />
    </svg>
  );
}

/** Lettered fallback tints for providers without an openly licensed glyph. */
const providerTint: Record<string, string> = {
  Postmark: "#F5C300",
};

function monogram(name: string) {
  const words = name.split(/\s+/).filter(Boolean);
  if (name === "AWS") return "AW";
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 1).toUpperCase();
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ProviderMark({
  provider,
  size,
  tone = "light",
}: {
  provider: string;
  size: number;
  tone?: "light" | "dark";
}) {
  const logo = providerLogos[provider];
  const radius = Math.round(size * 0.28);
  if (logo) {
    const lum = luminance(logo.hex);
    // Very light brand colours sit on an ink tile; near-black ones flip to cream on dark surfaces.
    const inkTile = lum > 0.75;
    const fill = tone === "dark" && lum < 0.15 ? "#F3EEE3" : logo.hex;
    return (
      <span
        aria-hidden="true"
        className={
          inkTile
            ? `${s.logoTile} ${s.logoTileInk}`
            : tone === "dark"
              ? `${s.logoTile} ${s.logoTileDark}`
              : s.logoTile
        }
        style={{ width: size, height: size, borderRadius: radius }}
      >
        <svg viewBox="0 0 24 24" width={Math.round(size * 0.56)} height={Math.round(size * 0.56)}>
          {logo.path ? (
            <path d={logo.path} fill={fill} fillRule={logo.evenOdd ? "evenodd" : undefined} />
          ) : null}
          {logo.parts?.map((part) => (
            <path
              key={part.d.slice(0, 24)}
              d={part.d}
              fill={part.fill ?? fill}
              fillRule={logo.evenOdd ? "evenodd" : undefined}
            />
          ))}
        </svg>
      </span>
    );
  }
  const tint = providerTint[provider] ?? "#5A6577";
  return (
    <span
      aria-hidden="true"
      className={tone === "dark" ? `${s.mark} ${s.markDark}` : s.mark}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize: Math.round(size * (monogram(provider).length > 1 ? 0.36 : 0.46)),
        ["--tint" as string]: tint,
      }}
    >
      {monogram(provider)}
    </span>
  );
}
