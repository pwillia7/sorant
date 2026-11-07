import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { siteUrl } from "@/lib/env";
import "./globals.css";

/*
  Archivo for everything set in words, with its width axis loaded: the
  condensed cut is the section lettering and the display titles, the normal
  cut the working text. JetBrains Mono for anything read as a number — run
  clocks, seeds, estimates — where columns of digits have to line up.
*/
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Soran’t",
  description: "Generate video on a local ComfyUI instance.",
  /*
    What the Open Graph image's URL is resolved against. The image itself is
    `opengraph-image.png` beside this file, which Next finds on its own — but an
    OG URL has to be absolute, and without this it resolves to localhost on
    every build, warning as it goes. See `siteUrl`, which reads the deployment
    rather than naming a domain this repo cannot know.

    The icons are not here for the same reason: `favicon.ico`, `icon.svg` and
    `apple-icon.png` are found by filename and need no declaration.
  */
  metadataBase: siteUrl(),
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f3f3" },
    { media: "(prefers-color-scheme: dark)", color: "#121313" },
  ],
};

/**
 * Applied before paint so a stored theme or palette does not flash the wrong
 * colours. Kept tiny and dependency-free on purpose.
 */
const themeScript = `
try {
  var stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.dataset.theme = stored;
  }
  var palette = localStorage.getItem('palette');
  if (palette && /^[a-z-]+$/.test(palette) && palette !== 'vichy') {
    document.documentElement.dataset.palette = palette;
  }
} catch (e) {}
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    /*
      The font variables belong on <html>, not <body>.

      Tailwind declares --font-sans and --default-font-family on :root as
      `var(--font-archivo), …`. A custom property is substituted using the
      variables of the element it is declared on, so with --font-archivo
      defined a level lower there is nothing for :root to resolve against and
      --font-sans computes to the guaranteed-invalid value. Everything
      inheriting it then silently falls back to the browser default, and a
      var() fallback does not help — those apply to undefined properties, not
      invalid ones. Utilities like font-sans still worked, because they are
      applied inside <body> where the variable does inherit, which is what made
      it look like a button problem rather than a page-wide one.
    */
    <html
      lang="en"
      className={`${archivo.variable} ${jetbrains.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
