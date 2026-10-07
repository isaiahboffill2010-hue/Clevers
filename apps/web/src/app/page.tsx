import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Remote Browser</h1>
      <p>Phase 4 display-only remote viewport.</p>
      <Link href="/browser">Open remote viewport</Link>
    </main>
  );
}
