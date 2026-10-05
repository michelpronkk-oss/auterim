import { SiteShell } from "@/app/_site/site-shell";
import type { SiteSection } from "@/app/_site/site-header";

/**
 * Frame for the changes, tools and pricing pages: the shared site header and footer around
 * their existing content.
 */
export function PublicShell({
  current,
  children,
}: {
  current?: SiteSection;
  children: React.ReactNode;
}) {
  return (
    <SiteShell current={current} hero={null}>
      <div className="public-shell public-shell-framed">{children}</div>
    </SiteShell>
  );
}
