import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "material-symbols/rounded.css";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { tokenHex } from "@/lib/md3-token-hex";

export const metadata: Metadata = {
  title: "Giya",
  description: "Turn every receipt into rewards. Giya is the loyalty and rewards app for Philippine food and retail.",
  icons: { icon: "/brand/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: tokenHex("surface", "light") },
    { media: "(prefers-color-scheme: dark)", color: tokenHex("surface", "dark") },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${GeistSans.variable} ${GeistMono.variable} font-sans antialiased`}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
