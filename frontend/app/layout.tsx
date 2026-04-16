import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "YT Clipper - Long Video to Shorts",
  description: "YouTube long video ko top 10 short clips mein convert karo",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
