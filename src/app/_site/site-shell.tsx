import type { ReactNode } from "react";
import { geist, geistMono } from "./fonts";
import { SiteFooter } from "./site-footer";
import { SiteHeader, type SiteSection } from "./site-header";
import s from "./site.module.css";

/** Page frame for public pages outside the homepage: same frame, header and footer. */
export function SiteShell({
  current,
  hero,
  children,
}: {
  current?: SiteSection;
  hero: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`${geist.variable} ${geistMono.variable} ${s.page}`}>
      <div className={s.frame}>
        <div className={s.top}>
          <SiteHeader current={current} />
          {hero}
        </div>
        <main id="content">{children}</main>
        <SiteFooter />
      </div>
    </div>
  );
}
