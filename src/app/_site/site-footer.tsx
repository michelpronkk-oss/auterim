import Link from "next/link";
import { BrandMark } from "@/app/_home/marks";
import s from "./site.module.css";

const columns: Array<{ title: string; links: Array<[label: string, href: string]> }> = [
  {
    title: "PRODUCT",
    links: [
      ["Product", "/product"],
      ["Pricing", "/#pricing"],
      ["Changes", "/changes"],
      ["Stack Scanner", "/tools/stack-scanner"],
    ],
  },
  {
    title: "RESOURCES",
    links: [
      ["How it works", "/how-it-works"],
      ["Tools", "/tools"],
      ["Security", "/security"],
    ],
  },
  {
    title: "TRUST & LEGAL",
    links: [
      ["Privacy", "/privacy"],
      ["Terms", "/terms"],
      ["Cookie Policy", "/cookies"],
    ],
  },
  {
    title: "ACCOUNT",
    links: [
      ["Sign in", "/login"],
      ["Create account", "/signup"],
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className={s.footer}>
      <div className={s.footerTop}>
        <div className={s.footerBrand}>
          <Link href="/" aria-label="Auterim home" className={s.logo}>
            <BrandMark size={24} />
            <span>Auterim</span>
          </Link>
          <p>Quiet intelligence for the systems your business depends on.</p>
        </div>
        <nav aria-label="Footer navigation" className={s.footerCols}>
          {columns.map((col) => (
            <div key={col.title} className={s.footerCol}>
              <h2 className={s.footerHead}>{col.title}</h2>
              <ul>
                {col.links.map(([label, href]) => (
                  <li key={href}>
                    <Link href={href}>{label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className={s.footerBottom}>
        <span className={s.copyright}>© 2026 Auterim</span>
        <span className={s.footerLine}>Know what will break before it breaks.</span>
      </div>
    </footer>
  );
}
