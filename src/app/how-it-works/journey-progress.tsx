"use client";

import { useEffect } from "react";

/**
 * Drives the journey rail: fills it as the reader scrolls and lights each stage's dot once
 * it has been reached. Without JavaScript, or with reduced motion, the rail renders full.
 */
export function JourneyProgress({ targetId }: { targetId: string }) {
  useEffect(() => {
    const root = document.getElementById(targetId);
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const stages = Array.from(root.querySelectorAll<HTMLElement>("[data-stage]"));
    let frame = 0;
    const update = () => {
      frame = 0;
      const box = root.getBoundingClientRect();
      const line = window.innerHeight * 0.6;
      const progress = Math.max(0, Math.min(1, (line - box.top) / box.height));
      root.style.setProperty("--progress", progress.toFixed(4));
      for (const stage of stages) {
        if (stage.getBoundingClientRect().top < line) stage.setAttribute("data-on", "");
        else stage.removeAttribute("data-on");
      }
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    root.setAttribute("data-ready", "");
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      root.removeAttribute("data-ready");
    };
  }, [targetId]);
  return null;
}
