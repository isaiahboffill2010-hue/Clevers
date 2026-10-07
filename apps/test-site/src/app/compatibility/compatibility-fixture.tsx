"use client";

import { useEffect, useState } from "react";

declare global {
  interface Window {
    compatibilityExternalScript?: boolean;
  }
}

export function CompatibilityFixture() {
  const [status, setStatus] = useState("pending");

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/compatibility/resource");
      const fetched = (await response.json()) as { ok: boolean };
      const blobText = await fetch(
        URL.createObjectURL(new Blob(["blob-ok"], { type: "text/plain" })),
      ).then((result) => result.text());
      const dataText = await fetch("data:text/plain,data-ok").then((result) => result.text());
      setStatus(
        fetched.ok &&
          blobText === "blob-ok" &&
          dataText === "data-ok" &&
          window.compatibilityExternalScript
          ? "ready"
          : "failed",
      );
    })();
  }, []);

  return (
    <main className="compatibility-fixture">
      <script src="/compatibility-external.js" />
      <h1>Compatibility fixture</h1>
      <img src="/compatibility-image.svg" alt="fixture" />
      <output id="compatibility-status">{status}</output>
    </main>
  );
}
