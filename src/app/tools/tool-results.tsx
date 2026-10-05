import Link from "next/link";
import { getPublicToolDirectory } from "@/lib/public/intelligence";

type Props = { kind: "exposure" | "deprecation"; provider?: string };

export async function ToolResults({ kind, provider }: Props) {
  const directory = await getPublicToolDirectory();
  const selected = provider ? directory.find((item) => item.slug === provider) : null;
  const eligible =
    kind === "deprecation"
      ? (selected ? [selected] : directory).map((item) => ({
          ...item,
          approvedChanges: item.approvedChanges.filter((change) =>
            /deprecat|sunset|retir|end.of.life|deadline/i.test(
              `${change.label} ${change.headline} ${change.summary}`,
            ),
          ),
        }))
      : selected
        ? [selected]
        : [];

  return (
    <section className="public-tool-results" aria-live="polite">
      <form className="public-filter-form" method="get">
        <label htmlFor="provider">
          {kind === "exposure" ? "Dependency catalog" : "Filter by provider"}
        </label>
        <select id="provider" name="provider" defaultValue={provider ?? ""}>
          <option value="">{kind === "exposure" ? "Choose a dependency" : "All providers"}</option>
          {directory.map((item) => (
            <option key={item.slug} value={item.slug}>
              {item.name}
            </option>
          ))}
        </select>
        <button className="button-secondary">
          {kind === "exposure" ? "Check coverage" : "Check approved changes"}
        </button>
      </form>
      {kind === "exposure" && selected && (
        <article className="public-tool-result-card">
          <p className="eyebrow">REAL SOURCE CATALOG COVERAGE</p>
          <h2>{selected.name}</h2>
          <p>
            {selected.sourceCoveragePartial ? "At least " : ""}
            {selected.authoritativeSources} enabled authoritative source
            {selected.authoritativeSources === 1 ? "" : "s"} in the catalog. This is global
            monitoring coverage, not proof that your code uses this dependency.
          </p>
          {selected.authoritativeSources > 0 && (
            <ul className="coverage-types">
              {Object.entries(selected.sourcesByType)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([type, count]) => (
                  <li key={type}>
                    <span>{type.replaceAll("_", " ")}</span>
                    <strong>
                      {selected.sourceCoveragePartial ? "at least " : ""}
                      {count}
                    </strong>
                  </li>
                ))}
            </ul>
          )}
          <h3>Approved current intelligence</h3>
          {selected.approvedChanges.length ? (
            <ul className="tool-change-results">
              {selected.approvedChanges.map((change) => (
                <li key={change.id}>
                  <Link href={`/changes/${selected.slug}/${change.canonicalSlug}`}>
                    {change.headline}
                  </Link>
                  <small>
                    {change.freshness}
                    {change.effectiveAt
                      ? ` · effective ${new Date(change.effectiveAt).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}`
                      : ""}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="public-empty">
              No currently approved change page is available for this dependency.
            </p>
          )}
        </article>
      )}
      {kind === "deprecation" && selected && (
        <article className="public-tool-result-card">
          <p className="eyebrow">APPROVED EVIDENCE</p>
          <h2>{selected.name}</h2>
          {eligible[0]?.approvedChanges.length ? (
            <ul className="tool-change-results">
              {eligible[0]!.approvedChanges.map((change) => (
                <li key={change.id}>
                  <Link href={`/changes/${selected.slug}/${change.canonicalSlug}`}>
                    {change.headline}
                  </Link>
                  <small>
                    {change.label} · {change.freshness}
                    {change.effectiveAt
                      ? ` · effective ${new Date(change.effectiveAt).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}`
                      : ""}
                  </small>
                  <p>{change.summary}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="public-empty">
              No approved deprecation or retirement-related change is currently available for this
              provider.
            </p>
          )}
        </article>
      )}
      {kind === "deprecation" && !selected && (
        <div className="public-change-list">
          {eligible
            .flatMap((item) => item.approvedChanges.map((change) => ({ provider: item, change })))
            .slice(0, 30)
            .map(({ provider: item, change }) => (
              <article className="public-change-card" key={change.id}>
                <p className="eyebrow">
                  {item.name} · {change.freshness}
                </p>
                <h3>
                  <Link href={`/changes/${item.slug}/${change.canonicalSlug}`}>
                    {change.headline}
                  </Link>
                </h3>
                <p>{change.summary}</p>
                {change.effectiveAt && (
                  <small>
                    Effective{" "}
                    {new Date(change.effectiveAt).toLocaleDateString("en-US", {
                      dateStyle: "medium",
                      timeZone: "UTC",
                    })}
                  </small>
                )}
              </article>
            ))}
        </div>
      )}
      {kind === "deprecation" &&
        !selected &&
        eligible.every((item) => !item.approvedChanges.length) && (
          <p className="public-empty">
            No approved deprecation or retirement-related changes are currently available. We won’t
            fill the gap with generated guesses.
          </p>
        )}
      {kind === "exposure" && !selected && (
        <p className="public-empty">
          Choose a dependency from the enabled catalog. Unknown providers are not added
          automatically.
        </p>
      )}
    </section>
  );
}
