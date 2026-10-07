export const metadata = { title: "Phase 4 Animated Fixture" };

export default function AnimatedFixture() {
  return (
    <main>
      <h1>Phase 4 live frame fixture</h1>
      <svg viewBox="0 0 800 400" role="img" aria-label="Animated streaming test marker">
        <rect width="800" height="400" fill="#10172a" />
        <circle cx="80" cy="200" r="48" fill="#4f8cff">
          <animate attributeName="cx" values="80;720;80" dur="2s" repeatCount="indefinite" />
        </circle>
      </svg>
    </main>
  );
}
