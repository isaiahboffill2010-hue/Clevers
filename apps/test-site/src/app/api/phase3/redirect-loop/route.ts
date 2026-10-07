export function GET() {
  return new Response(null, {
    status: 302,
    headers: { location: "/api/phase3/redirect-loop" },
  });
}
