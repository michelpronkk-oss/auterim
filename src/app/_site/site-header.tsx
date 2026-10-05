"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { focusHeroInput } from "@/app/_home/hero";
import { BrandMark } from "@/app/_home/marks";
import s from "./site.module.css";

export type SiteSection = "product" | "how" | "pricing" | "changes" | "tools" | "legal";

type NavItem = { href: string; label: string; key?: SiteSection; hint: string; icon: IconName };

const primary: NavItem[] = [
  {
    href: "/product",
    label: "Product",
    key: "product",
    hint: "What Auterim does, part by part",
    icon: "layers",
  },
  {
    href: "/how-it-works",
    label: "How it works",
    key: "how",
    hint: "One change, followed start to finish",
    icon: "route",
  },
  {
    href: "/#pricing",
    label: "Pricing",
    key: "pricing",
    hint: "Core, Pro and Business",
    icon: "tag",
  },
  {
    href: "/changes",
    label: "Changes",
    key: "changes",
    hint: "What providers changed recently",
    icon: "pulse",
  },
];

const mobileOnly: NavItem[] = [
  {
    href: "/tools",
    label: "Tools",
    key: "tools",
    hint: "Free scanners and checkers",
    icon: "tool",
  },
];

type IconName = "layers" | "route" | "tag" | "pulse" | "tool";

/** Small line icons for the mobile menu, drawn on a 20px grid. */
const iconPaths: Record<IconName, string> = {
  layers: "M10 3 3 6.5 10 10l7-3.5L10 3ZM3 10l7 3.5 7-3.5M3 13.5 10 17l7-3.5",
  route:
    "M5 4.5a1.5 1.5 0 1 0 0 .01M15 15.5a1.5 1.5 0 1 0 0 .01M6.5 4.5h6a2.5 2.5 0 0 1 0 5h-5a2.5 2.5 0 0 0 0 5h6",
  tag: "M3.5 3.5h6l7 7-6 6-7-7v-6ZM7 7h.01",
  pulse: "M2.5 10h3l2-5 4 10 2-5h4",
  tool: "M12.5 3.5a4 4 0 0 0-3.9 5L3.5 13.6a1.4 1.4 0 0 0 2 2l5.1-5.1a4 4 0 0 0 5-3.9l-2.4 2.4-2.1-.6-.6-2.1 2.4-2.4Z",
};

function MenuIcon({ name }: { name: IconName }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d={iconPaths[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MOBILE_QUERY = "(max-width: 879px)";

/**
 * Shared public header. On the homepage the CTA focuses the hero scanner in place;
 * everywhere else it links to the scanner at /#scan.
 */
export function SiteHeader({
  current,
  onHome = false,
}: {
  current?: SiteSection;
  onHome?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    // Focus the panel itself, so a tap does not draw a focus ring on the first item.
    wrapRef.current?.querySelector<HTMLElement>("[data-menu-panel]")?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const media = window.matchMedia(MOBILE_QUERY);
    const onMedia = () => {
      if (!media.matches) close();
    };
    document.addEventListener("keydown", onKey);
    media.addEventListener("change", onMedia);
    return () => {
      root.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
      media.removeEventListener("change", onMedia);
    };
  }, [open, close]);

  const onScan = (event: React.MouseEvent) => {
    if (!onHome) return;
    event.preventDefault();
    close();
    focusHeroInput();
  };

  const onBlurWithin = (event: React.FocusEvent) => {
    if (open && !wrapRef.current?.contains(event.relatedTarget as Node | null)) close();
  };

  const isActive = (key?: SiteSection) => (key && key === current ? "page" : undefined);

  return (
    <>
      {open ? <div className={s.menuBackdrop} aria-hidden="true" onClick={() => close()} /> : null}
      <div ref={wrapRef} className={s.headerWrap} onBlur={onBlurWithin}>
        <header className={s.header}>
          <Link href="/" aria-label="Auterim home" className={s.logo} onClick={() => close()}>
            <BrandMark size={26} />
            <span>Auterim</span>
          </Link>
          <nav aria-label="Main navigation" className={s.nav}>
            {primary.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={s.navLink}
                aria-current={isActive(item.key)}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className={s.actions}>
            <Link href="/login" className={s.signIn}>
              Sign in
            </Link>
            <Link href="/#scan" className={s.cta} onClick={onScan}>
              <span className={s.ctaLong}>Scan your company</span>
              <span className={s.ctaShort}>Scan</span>
            </Link>
            <button
              ref={buttonRef}
              type="button"
              data-burger
              className={s.burger}
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((v) => !v)}
            >
              <span className={s.burgerLines} data-open={open || undefined} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div id={panelId} className={s.menu} hidden={!open}>
          {open ? (
            <nav
              aria-label="Mobile navigation"
              className={s.menuInner}
              data-menu-panel
              tabIndex={-1}
            >
              <ul className={s.menuList}>
                {[...primary, ...mobileOnly].map((item, i) => (
                  <li key={item.href} style={{ ["--i" as string]: i }}>
                    <Link
                      href={item.href}
                      className={s.menuLink}
                      aria-current={isActive(item.key)}
                      onClick={() => close()}
                    >
                      <span className={s.menuIcon}>
                        <MenuIcon name={item.icon} />
                      </span>
                      <span className={s.menuText}>
                        <span className={s.menuLabel}>{item.label}</span>
                        <span className={s.menuHint}>{item.hint}</span>
                      </span>
                      {isActive(item.key) ? (
                        <span className={s.menuHere} aria-hidden="true" />
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className={s.menuRule} />
              <Link href="/login" className={s.menuSignIn} onClick={() => close()}>
                Sign in
              </Link>
              <Link href="/#scan" className={s.menuCta} onClick={onScan}>
                Scan your company
                <span aria-hidden="true">→</span>
              </Link>
            </nav>
          ) : null}
        </div>
      </div>
    </>
  );
}
