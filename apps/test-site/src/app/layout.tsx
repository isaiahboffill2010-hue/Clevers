import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Remote Browser Test Site" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
