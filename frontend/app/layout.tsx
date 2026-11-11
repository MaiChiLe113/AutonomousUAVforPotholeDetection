import "leaflet/dist/leaflet.css";
import "./globals.css";

import type { Metadata, Viewport } from "next";

import AppShell from "@/components/AppShell";
import { APP } from "@/lib/config";

export const metadata: Metadata = {
  title: APP.name,
  description: APP.description,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
