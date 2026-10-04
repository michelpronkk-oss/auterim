"use client";

import { useEffect } from "react";

/**
 * Scroll reveal for elements marked `data-reveal`. Motion is opt-in from here: without
 * JavaScript, or with reduced motion requested, nothing is ever hidden.
 */
export function RevealOnScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    let pending = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    let frame = 0;
    // Anything at or above the lower edge of the viewport shows, including elements a jump
    // (an anchor link, a fast fling) scrolled straight past.
    const update = () => {
      frame = 0;
      const edge = window.innerHeight * 0.92;
      pending = pending.filter((el) => {
        if (el.getBoundingClientRect().top >= edge) return true;
        el.setAttribute("data-shown", "");
        return false;
      });
      if (!pending.length) window.removeEventListener("scroll", onScroll);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    root.setAttribute("data-reveal-ready", "");
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      root.removeAttribute("data-reveal-ready");
    };
  }, []);
  return null;
}
