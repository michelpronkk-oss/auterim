"use client";

import { useEffect, useId, useRef, useState } from "react";
import s from "./security.module.css";

/**
 * "On this page" index. Desktop: a sticky list beside the details. Phones and tablets: a
 * pinned bar naming the section being read, with a progress line, that opens the full list.
 */
export function DetailIndex({ items }: { items: Array<{ id: string; title: string }> }) {
  const [active, setActive] = useState(items[0]?.id);
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    const update = () => {
      const line = Math.min(window.innerHeight * 0.35, 200);
      let current = items[0]?.id;
      for (const item of items) {
        const el = document.getElementById(item.id);
        if (el && el.getBoundingClientRect().top < line) current = item.id;
      }
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [items]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const index = Math.max(
    0,
    items.findIndex((item) => item.id === active),
  );
  const total = String(items.length).padStart(2, "0");

  return (
    <nav
      ref={navRef}
      aria-label="On this page"
      className={s.index}
      data-open={open || undefined}
      style={{ ["--read" as string]: (index + 1) / items.length }}
    >
      <span className={s.indexHead}>ON THIS PAGE</span>
      <button
        ref={buttonRef}
        type="button"
        className={s.jump}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={s.jumpCount}>
          <b>{String(index + 1).padStart(2, "0")}</b> / {total}
        </span>
        <span className={s.jumpTitle}>{items[index]?.title}</span>
        <span className={s.jumpLabel}>{open ? "Close" : "Sections"}</span>
        <span className={s.jumpChevron} aria-hidden="true" />
        <span className={s.jumpProgress} aria-hidden="true" />
      </button>
      <ol id={panelId} className={s.indexList}>
        {items.map((item, i) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={item.id === active ? "location" : undefined}
              className={s.indexLink}
              onClick={() => setOpen(false)}
            >
              <span className={s.indexNum}>{String(i + 1).padStart(2, "0")}</span>
              {item.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
