"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { focusHeroInput } from "@/app/_home/hero";
import { BrandMark } from "@/app/_home/marks";
import s from "./site.module.css";

export type SiteSection = "product" | "pricing" | "changes" | "tools" | "legal";

const primary: Array<{ href: string; label: string; key?: SiteSection }> = [
  { href: "/product", label: "Product", key: "product" },
  { href: "/product#how-it-works", label: "How it works" },
  { href: "/#pricing", label: "Pricing", key: "pricing" },
  { href: "/changes", label: "Changes", key: "changes" },
];

const mobileOnly: Array<{ href: string; label: string; key?: SiteSection }> = [
  { href: "/tools", label: "Tools", key: "tools" },
];

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
    wrapRef.current?.querySelector<HTMLAnchorElement>("[data-menu-link]")?.focus();

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
            <nav aria-label="Mobile navigation" className={s.menuInner}>
              <ul className={s.menuList}>
                {[...primary, ...mobileOnly].map((item) => (
                  <li key={item.href}>
                    <Link
                      data-menu-link
                      href={item.href}
                      className={s.menuLink}
                      aria-current={isActive(item.key)}
                      onClick={() => close()}
                    >
                      {item.label}
                      <span aria-hidden="true" className={s.menuArrow}>
                        →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className={s.menuRule} />
              <Link href="/login" className={s.menuLink} onClick={() => close()}>
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
