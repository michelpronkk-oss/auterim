"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId } from "react";
import { Chevron, tools as s } from "../tool-parts";

/** Pinned provider filter. Changing it reloads the list via ?provider=. */
export function ProviderFilter({
  providers,
  selected,
  count,
}: {
  providers: Array<{ slug: string; name: string }>;
  selected?: string;
  count: number;
}) {
  const router = useRouter();
  const id = useId();
  return (
    <div className={s.filterBar}>
      <form className={s.filterInner} method="get" onSubmit={(event) => event.preventDefault()}>
        <div className={s.filterField}>
          <label htmlFor={id} className={s.label}>
            PROVIDER
          </label>
          <div className={s.selectWrap}>
            <select
              id={id}
              name="provider"
              className={s.select}
              value={selected ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                router.push(
                  value
                    ? `/tools/deprecation-checker?provider=${encodeURIComponent(value)}`
                    : "/tools/deprecation-checker",
                  { scroll: false },
                );
              }}
            >
              <option value="">All providers</option>
              {providers.map((provider) => (
                <option key={provider.slug} value={provider.slug}>
                  {provider.name}
                </option>
              ))}
            </select>
            <span className={s.selectChevron}>
              <Chevron />
            </span>
          </div>
        </div>
        <div className={s.filterEnd}>
          <span aria-live="polite" className={s.count}>
            {count} approved change{count === 1 ? "" : "s"}
          </span>
          {selected ? (
            <Link href="/tools/deprecation-checker" scroll={false} className={s.clear}>
              Clear
            </Link>
          ) : null}
        </div>
      </form>
    </div>
  );
}
