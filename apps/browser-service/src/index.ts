import { SHUTDOWN_TIMEOUT_MS } from "./config.js";
import { createServer } from "./server/create-server.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "127.0.0.1";
const server = createServer({ logger: true });

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  server.log.info({ signal }, "browser service shutdown requested");
  shutdownPromise = withShutdownTimeout(server.close()).catch((error: unknown) => {
    server.log.error({ error }, "browser service shutdown failed");
    process.exitCode = 1;
  });
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

async function withShutdownTimeout(operation: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Browser service shutdown timed out")),
      SHUTDOWN_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

try {
  await server.listen({ host, port });
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
}
