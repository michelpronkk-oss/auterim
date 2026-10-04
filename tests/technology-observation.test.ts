import { describe, expect, it } from "vitest";
import { discoverWebsiteDependencies } from "@/lib/discovery/discovery";
import type { FetchResult } from "@/lib/monitoring/fetcher";
import { publicStackScanResult } from "@/lib/public/stack-scan";

function html(body: string): FetchResult {
  return {
    status: 200,
    body: Buffer.from(body),
    bytesRead: Buffer.byteLength(body),
    bodyTruncated: false,
    contentType: "text/html",
    safeHeaders: {},
    etag: null,
    lastModified: null,
    finalUrl: "https://fixture.example/",
  };
}

const positiveFixtures = [
  {
    label: "Next.js production chunk",
    html: '<script src="/_next/static/chunks/app-abcd.js"></script>',
    slug: "nextjs",
  },
  {
    label: "explicit React CDN",
    html: '<script src="https://unpkg.com/react@19.0.0/umd/react.production.min.js"></script>',
    slug: "react",
  },
  {
    label: "Tailwind browser CDN",
    html: '<script src="https://cdn.tailwindcss.com"></script>',
    slug: "tailwindcss",
  },
  {
    label: "Vite development client",
    html: '<script type="module" src="/@vite/client"></script>',
    slug: "vite",
  },
  {
    label: "WordPress generator plus platform path",
    html: '<meta name="generator" content="WordPress 6.8"><script src="/wp-content/themes/site/app.js"></script>',
    slug: "wordpress",
  },
] as const;

const negativeFixtures = [
  {
    label: "framework names in copy",
    html: "<p>Next.js, React, Tailwind, Moodle, Drupal, Intercom</p>",
  },
  { label: "Next image optimizer only", html: '<img src="/_next/image?url=%2Fhero.png">' },
  {
    label: "lookalike Tailwind host",
    html: '<script src="https://cdn.tailwindcss.com.attacker.example/a.js"></script>',
  },
  { label: "lookalike framework path", html: '<script src="/not-next/static/app.js"></script>' },
  {
    label: "copied integration directory",
    html: "<p>Example setup: add WordPress, Moodle, Drupal or Intercom to your project.</p>",
  },
] as const;

async function observe(body: string) {
  return discoverWebsiteDependencies("https://fixture.example/", {
    fetcher: async () => html(body),
  });
}

describe("versioned technology observation registry", () => {
  it.each(positiveFixtures)("recognizes $label as non-protectable observation", async (fixture) => {
    const result = await observe(fixture.html);
    const observation = result.technologyObservations?.find(
      ({ technologySlug }) => technologySlug === fixture.slug,
    );
    expect(observation).toMatchObject({
      technologySlug: fixture.slug,
      registryVersion: "2026-10-04.1",
      strength: "strong",
      protectability: "non_protectable",
      disposition: "suppressed",
    });
    expect(result.candidates).toEqual([]);
  });

  it.each(negativeFixtures)("rejects $label", async (fixture) => {
    const result = await observe(fixture.html);
    expect(result.technologyObservations ?? []).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("meets the labeled offline precision benchmark without treating unknown as absent", async () => {
    let truePositives = 0;
    let falsePositives = 0;
    let trueNegatives = 0;
    for (const fixture of positiveFixtures) {
      const result = await observe(fixture.html);
      const found = result.technologyObservations?.some(
        ({ technologySlug }) => technologySlug === fixture.slug,
      );
      if (found) truePositives += 1;
      else falseNegatives();
    }
    for (const fixture of negativeFixtures) {
      const result = await observe(fixture.html);
      const found = (result.technologyObservations?.length ?? 0) > 0;
      if (found) falsePositives += 1;
      else trueNegatives += 1;
    }
    expect(truePositives / positiveFixtures.length).toBe(1);
    expect(falsePositives).toBe(0);
    expect(trueNegatives / negativeFixtures.length).toBe(1);
  });

  it("does not expose fingerprint details through the public scanner response", async () => {
    const result = await observe(positiveFixtures[0]!.html);
    const publicResult = publicStackScanResult(result);
    expect(JSON.stringify(publicResult)).not.toContain("technologyObservations");
    expect(JSON.stringify(publicResult)).not.toContain("nextjs-static-script");
    expect(JSON.stringify(publicResult)).not.toContain("registryVersion");
  });
});

function falseNegatives(): never {
  throw new Error("A labeled-present technology fixture was missed.");
}
