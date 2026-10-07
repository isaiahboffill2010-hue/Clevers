import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { ClientStreamMessage } from "@remote-browser/protocol";
import { NavigationPolicyError } from "@remote-browser/security";
import Fastify from "fastify";
import type WebSocket from "ws";
import { BrowserManager } from "../browser/browser-manager.js";
import {
  STREAM_AUTH_TIMEOUT_MS,
  STREAM_HEARTBEAT_INTERVAL_MS,
  STREAM_MAX_CONTROL_BYTES,
  STREAM_TICKET_TTL_MS,
} from "../config.js";
import { SessionLimitError, SessionNotFoundError } from "../sessions/session-registry.js";
import type { NavigationResult, ProofResult, SessionSnapshot } from "../sessions/session-types.js";
import type { ScreencastSink } from "../streaming/screencast-controller.js";
import { StreamTicketError, StreamTicketStore } from "../streaming/stream-ticket-store.js";
import { parseViewport, type ViewportSize } from "../streaming/viewport.js";

export interface BrowserController {
  createSession(): Promise<SessionSnapshot>;
  getSession(id: string): SessionSnapshot;
  runProof(id: string): Promise<ProofResult>;
  navigate(id: string, url: string): Promise<NavigationResult>;
  destroySession(id: string): Promise<boolean>;
  attachStream?(id: string, sink: ScreencastSink): Promise<void>;
  detachStream?(id: string): Promise<void>;
  resizeViewport?(id: string, viewport: ViewportSize): Promise<void>;
  dispatchInput?(
    id: string,
    message: Extract<ClientStreamMessage, { type: `input.${string}` }>,
  ): Promise<void>;
  shutdown(): Promise<void>;
}

interface ServerOptions {
  logger?: boolean;
  browserController?: BrowserController;
  targetUrl?: string;
  ticketStore?: StreamTicketStore;
}

const emptyQuerySchema = { type: "object", additionalProperties: false, maxProperties: 0 } as const;

export function createServer(options: ServerOptions = {}) {
  const server = Fastify({ logger: options.logger ?? false });
  void server.register(cors, {
    origin: ["http://127.0.0.1:3000", "http://localhost:3000"],
    methods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
  });
  void server.register(websocket, { options: { maxPayload: STREAM_MAX_CONTROL_BYTES } });
  const browserController =
    options.browserController ??
    new BrowserManager({ logger: server.log, targetUrl: options.targetUrl });
  const ticketStore = options.ticketStore ?? new StreamTicketStore(STREAM_TICKET_TTL_MS);

  server.get("/health", async () => ({
    ok: true,
    service: "browser-service",
  }));

  server.post(
    "/internal/browser-session",
    { schema: { querystring: emptyQuerySchema } },
    async (request, reply) => {
      if (hasProperties(request.body)) {
        return reply.code(400).send({ ok: false, error: "REQUEST_BODY_NOT_ALLOWED" });
      }
      try {
        const session = await browserController.createSession();
        return reply.code(201).send({ ok: true, ...session });
      } catch (error) {
        if (error instanceof SessionLimitError) {
          return reply.code(409).send({
            ok: false,
            error: "SESSION_LIMIT_REACHED",
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/internal/browser-session/:sessionId/run-proof",
    { schema: { querystring: emptyQuerySchema } },
    async (request, reply) => {
      if (hasProperties(request.body)) {
        return reply.code(400).send({ ok: false, error: "REQUEST_BODY_NOT_ALLOWED" });
      }
      try {
        const result = await browserController.runProof(request.params.sessionId);
        return { ok: true, ...result };
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });
        }
        throw error;
      }
    },
  );

  server.post<{ Params: { sessionId: string }; Body: unknown }>(
    "/internal/browser-session/:sessionId/navigate",
    { schema: { querystring: emptyQuerySchema } },
    async (request, reply) => {
      const url = extractNavigationUrl(request.body);
      if (!url) {
        return reply.code(400).send({
          ok: false,
          error: "NAVIGATION_INVALID_URL",
          message: "A single string URL field is required",
        });
      }
      try {
        const result = await browserController.navigate(request.params.sessionId, url);
        return { ok: true, ...result, status: result.state };
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });
        }
        if (error instanceof NavigationPolicyError) {
          return reply.code(400).send({ ok: false, error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/internal/browser-session/:sessionId/stream-ticket",
    { schema: { querystring: emptyQuerySchema } },
    async (request, reply) => {
      if (hasProperties(request.body)) {
        return reply.code(400).send({ ok: false, error: "REQUEST_BODY_NOT_ALLOWED" });
      }
      try {
        const session = browserController.getSession(request.params.sessionId);
        if (
          session.state === "closed" ||
          session.state === "closing" ||
          session.state === "crashed"
        ) {
          return reply.code(409).send({ ok: false, error: "STREAM_SESSION_CLOSED" });
        }
        const issued = ticketStore.issue(session.sessionId);
        return reply.code(201).send({ ok: true, sessionId: session.sessionId, ...issued });
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return reply.code(404).send({ ok: false, error: "STREAM_SESSION_NOT_FOUND" });
        }
        throw error;
      }
    },
  );

  void server.register(async (streamServer) => {
    streamServer.get("/ws/browser", { websocket: true }, (socket, request) => {
      let sessionId: string | undefined;
      let authenticated = false;
      let alive = true;
      let inputWindowStarted = Date.now();
      let inputCount = 0;

      const sendControl = (message: object) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      };
      const reject = (code: string, message: string) => {
        sendControl({ v: 1, type: "stream.error", code, message });
        socket.close(1008, code);
      };
      const authTimer = setTimeout(() => {
        reject("STREAM_AUTH_FAILED", "Stream authentication timed out");
      }, STREAM_AUTH_TIMEOUT_MS);
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, STREAM_HEARTBEAT_INTERVAL_MS);

      socket.on("pong", () => {
        alive = true;
      });

      socket.on("message", (data, isBinary) => {
        void handleMessage(data, isBinary).catch((error: unknown) => {
          request.log.error({ sessionId, error }, "stream message handling failed");
          reject("STREAM_INTERNAL_ERROR", "The stream encountered an internal error");
        });
      });

      socket.on("close", (code, reason) => {
        clearTimeout(authTimer);
        clearInterval(heartbeat);
        if (sessionId && browserController.detachStream) {
          void browserController.detachStream(sessionId).catch((error: unknown) => {
            request.log.warn({ sessionId, error }, "stream disconnect cleanup failed");
          });
        }
        request.log.info(
          { sessionId, closeCode: code, reason: reason.toString().slice(0, 80) },
          "stream connection closed",
        );
      });

      async function handleMessage(data: WebSocket.RawData, isBinary: boolean): Promise<void> {
        if (isBinary || rawDataBytes(data) > STREAM_MAX_CONTROL_BYTES) {
          reject("STREAM_INVALID_MESSAGE", "Only bounded JSON control messages are accepted");
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(data.toString());
        } catch {
          reject("STREAM_INVALID_MESSAGE", "Malformed stream control message");
          return;
        }
        if (!isRecord(message) || message.v !== 1) {
          reject("STREAM_PROTOCOL_MISMATCH", "Unsupported stream protocol version");
          return;
        }

        if (!authenticated) {
          if (
            message.type !== "stream.authenticate" ||
            typeof message.ticket !== "string" ||
            !hasExactKeys(message, ["v", "type", "ticket"])
          ) {
            reject("STREAM_AUTH_FAILED", "A valid stream ticket is required");
            return;
          }
          try {
            sessionId = ticketStore.consume(message.ticket);
          } catch (error) {
            const code =
              error instanceof StreamTicketError && error.reason === "expired"
                ? "STREAM_TICKET_EXPIRED"
                : "STREAM_AUTH_FAILED";
            reject(code, "The stream ticket is invalid or unavailable");
            return;
          }
          try {
            browserController.getSession(sessionId);
          } catch (error) {
            if (error instanceof SessionNotFoundError) {
              reject("STREAM_SESSION_NOT_FOUND", "The browser session is unavailable");
              return;
            }
            throw error;
          }
          if (!browserController.attachStream) {
            reject("STREAM_INTERNAL_ERROR", "Streaming is unavailable");
            return;
          }
          const sink: ScreencastSink = {
            sendControl,
            sendBinary: (packet) => sendBinary(socket, packet),
          };
          authenticated = true;
          clearTimeout(authTimer);
          sendControl({ v: 1, type: "stream.authenticated", sessionId });
          try {
            await browserController.attachStream(sessionId, sink);
          } catch (error) {
            authenticated = false;
            const code =
              error instanceof Error && error.message === "STREAM_ALREADY_CONNECTED"
                ? "STREAM_ALREADY_CONNECTED"
                : error instanceof Error && error.message === "STREAM_SESSION_CLOSED"
                  ? "STREAM_SESSION_CLOSED"
                  : "STREAM_INTERNAL_ERROR";
            reject(code, "The browser stream could not be attached");
            return;
          }
          request.log.info({ sessionId }, "stream authentication succeeded");
          return;
        }

        if (message.type === "stream.ready" && hasExactKeys(message, ["v", "type"])) return;
        if (
          message.type === "frame.ack" &&
          Number.isInteger(message.sequence) &&
          hasExactKeys(message, ["v", "type", "sequence"])
        ) {
          return;
        }
        if (message.type === "session.ping" && hasOnlyKeys(message, ["v", "type", "timestamp"])) {
          sendControl({ v: 1, type: "session.pong", timestamp: message.timestamp });
          return;
        }
        if (
          message.type === "viewport.resize" &&
          hasExactKeys(message, ["v", "type", "width", "height"])
        ) {
          const viewport = parseViewport(message);
          if (!viewport || !sessionId || !browserController.resizeViewport) {
            reject("STREAM_INVALID_MESSAGE", "Invalid viewport dimensions");
            return;
          }
          await browserController.resizeViewport(sessionId, viewport);
          return;
        }
        if (typeof message.type === "string" && message.type.startsWith("input.")) {
          const input = parseInputMessage(message);
          if (!input || !sessionId || !browserController.dispatchInput) {
            reject("STREAM_INVALID_MESSAGE", "Invalid remote input message");
            return;
          }
          const now = Date.now();
          if (now - inputWindowStarted >= 1_000) {
            inputWindowStarted = now;
            inputCount = 0;
          }
          inputCount += 1;
          if (inputCount > 240) {
            reject("STREAM_INVALID_MESSAGE", "Remote input rate exceeded");
            return;
          }
          try {
            await browserController.dispatchInput(sessionId, input);
          } catch (error) {
            if (error instanceof Error && error.message === "STREAM_INVALID_INPUT") {
              reject("STREAM_INVALID_MESSAGE", "Remote input coordinates are outside the viewport");
              return;
            }
            throw error;
          }
          return;
        }
        reject("STREAM_INVALID_MESSAGE", "Unsupported stream control message");
      }
    });
  });

  server.get<{ Params: { sessionId: string } }>(
    "/internal/browser-session/:sessionId",
    { schema: { querystring: emptyQuerySchema } },
    async (request, reply) => {
      try {
        return { ok: true, ...browserController.getSession(request.params.sessionId) };
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });
        }
        throw error;
      }
    },
  );

  server.delete<{ Params: { sessionId: string } }>(
    "/internal/browser-session/:sessionId",
    { schema: { querystring: emptyQuerySchema } },
    async (request) => {
      const destroyed = await browserController.destroySession(request.params.sessionId);
      return { ok: true, sessionId: request.params.sessionId, destroyed };
    },
  );

  server.addHook("onClose", async () => {
    await browserController.shutdown();
  });

  return server;
}

function hasProperties(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function extractNavigationUrl(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0]?.[0] !== "url") return undefined;
  return typeof entries[0][1] === "string" ? entries[0][1] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function sendBinary(socket: WebSocket, packet: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== socket.OPEN) {
      reject(new Error("WebSocket is not open"));
      return;
    }
    socket.send(packet, { binary: true }, (error) => (error ? reject(error) : resolve()));
  });
}

function parseInputMessage(
  value: Record<string, unknown>,
): Extract<ClientStreamMessage, { type: `input.${string}` }> | undefined {
  const base = (keys: string[]) => hasExactKeys(value, ["v", "type", ...keys]);
  const finite = (key: string) => typeof value[key] === "number" && Number.isFinite(value[key]);
  const modifiers = () =>
    Number.isInteger(value.modifiers) &&
    (value.modifiers as number) >= 0 &&
    (value.modifiers as number) <= 15;
  switch (value.type) {
    case "input.focus":
    case "input.blur":
      return base([])
        ? (value as unknown as Extract<ClientStreamMessage, { type: "input.focus" | "input.blur" }>)
        : undefined;
    case "input.insertText":
      return base(["text"]) && typeof value.text === "string" && value.text.length <= 4_096
        ? (value as unknown as Extract<ClientStreamMessage, { type: "input.insertText" }>)
        : undefined;
    case "input.pointerMove":
      return base(["x", "y", "buttons", "modifiers"]) &&
        finite("x") &&
        finite("y") &&
        Number.isInteger(value.buttons) &&
        modifiers()
        ? (value as unknown as Extract<ClientStreamMessage, { type: "input.pointerMove" }>)
        : undefined;
    case "input.pointerDown":
    case "input.pointerUp":
      return base(["x", "y", "button", "buttons", "clickCount", "modifiers"]) &&
        finite("x") &&
        finite("y") &&
        ["left", "middle", "right"].includes(String(value.button)) &&
        Number.isInteger(value.buttons) &&
        Number.isInteger(value.clickCount) &&
        (value.clickCount as number) >= 1 &&
        (value.clickCount as number) <= 3 &&
        modifiers()
        ? (value as unknown as Extract<
            ClientStreamMessage,
            { type: "input.pointerDown" | "input.pointerUp" }
          >)
        : undefined;
    case "input.wheel":
      return base(["x", "y", "deltaX", "deltaY", "modifiers"]) &&
        finite("x") &&
        finite("y") &&
        finite("deltaX") &&
        finite("deltaY") &&
        modifiers()
        ? (value as unknown as Extract<ClientStreamMessage, { type: "input.wheel" }>)
        : undefined;
    case "input.keyDown":
    case "input.keyUp":
      return base(["key", "code", "repeat", "location", "modifiers"]) &&
        typeof value.key === "string" &&
        value.key.length <= 64 &&
        typeof value.code === "string" &&
        value.code.length <= 64 &&
        typeof value.repeat === "boolean" &&
        Number.isInteger(value.location) &&
        modifiers()
        ? (value as unknown as Extract<
            ClientStreamMessage,
            { type: "input.keyDown" | "input.keyUp" }
          >)
        : undefined;
    default:
      return undefined;
  }
}

function rawDataBytes(data: WebSocket.RawData): number {
  if (Array.isArray(data)) return data.reduce((total, item) => total + item.byteLength, 0);
  return data.byteLength;
}
