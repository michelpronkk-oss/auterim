import { Geist, Geist_Mono } from "next/font/google";

/** Same faces and weights as the homepage, so the auth pages read as one product. */
export const geist = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-geist",
});
export const geistMono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-geist-mono",
});
