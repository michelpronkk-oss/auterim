"use client";

import { useEffect, useRef, useState } from "react";
import s from "./security.module.css";

/** "On this page" index: a sticky list on desktop, a scrolling chip row on phones. */
export function DetailIndex({ items }: { items: Array<{ id: string; title: string }> }) {
  const [active, setActive] = useState(items[0]?.id);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const update = () => {
      const line = window.innerHeight * 0.35;
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

  // On the chip row, keep the active chip in view as the reader moves down the page.
  useEffect(() => {
    const list = listRef.current;
    if (!list || list.scrollWidth <= list.clientWidth) return;
    const chip = list.querySelector<HTMLElement>(`[href="#${active}"]`);
    if (!chip) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollTo({
      left:
        list.scrollLeft +
        chip.getBoundingClientRect().left -
        list.getBoundingClientRect().left -
        parseFloat(getComputedStyle(list).paddingLeft),
      behavior: reduce ? "auto" : "smooth",
    });
  }, [active]);

  return (
    <nav aria-label="On this page" className={s.index}>
      <span className={s.indexHead}>ON THIS PAGE</span>
      <ol ref={listRef}>
        {items.map((item, i) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={item.id === active ? "location" : undefined}
              className={s.indexLink}
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
