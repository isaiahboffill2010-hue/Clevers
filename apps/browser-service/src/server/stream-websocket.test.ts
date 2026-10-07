import type { SessionId } from "@remote-browser/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { NavigationResult, ProofResult, SessionSnapshot } from "../sessions/session-types.js";
import { encodeFrame } from "../streaming/frame-protocol.js";
import type { ScreencastSink } from "../streaming/screencast-controller.js";
import { StreamTicketStore } from "../streaming/stream-ticket-store.js";
import type { ViewportSize } from "../streaming/viewport.js";
import { type BrowserController, createServer } from "./create-server.js";

const servers: ReturnType<typeof createServer>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("authenticated stream WebSocket", () => {
  it("authenticates once, sends binary frames, resizes, and rejects commands", async () => {
    const controller = createController();
    const server = createServer({ browserController: controller });
    servers.push(server);
    const base = await listen(server);
    const ticket = await issueTicket(server);
    const socket = connect(base);
    const messages = collect(socket);
    await opened(socket);
    socket.send(JSON.stringify({ v: 1, type: "stream.authenticate", ticket }));

    await eventually(() =>
      messages.json.some((message) => message.type === "stream.authenticated"),
    );
    await eventually(() => messages.binary.length === 1);
    expect(messages.binary[0]?.subarray(0, 4).toString("ascii")).toBe("RBV1");

    socket.send(JSON.stringify({ v: 1, type: "viewport.resize", width: 800, height: 600 }));
    const resizeViewport = controller.resizeViewport;
    if (!resizeViewport) throw new Error("Test controller lacks resize support");
    await eventually(() => vi.mocked(resizeViewport).mock.calls.length === 1);
    expect(controller.resizeViewport).toHaveBeenCalledWith("session-a", {
      width: 800,
      height: 600,
    });
    socket.send(JSON.stringify({ v: 1, type: "input.focus" }));
    const dispatchInput = controller.dispatchInput;
    if (!dispatchInput) throw new Error("Test controller lacks input support");
    await eventually(() => vi.mocked(dispatchInput).mock.calls.length === 1);

    socket.send(JSON.stringify({ v: 1, type: "navigate", url: "https://example.com" }));
    await eventually(() =>
      messages.json.some((message) => message.code === "STREAM_INVALID_MESSAGE"),
    );
  });

  it("rejects reused, expired, malformed, oversized, and mismatched tickets/messages", async () => {
    let now = 1_000;
    const ticketStore = new StreamTicketStore(50, () => now);
    const server = createServer({ browserController: createController(), ticketStore });
    servers.push(server);
    const base = await listen(server);

    const reusableTicket = await issueTicket(server);
    const first = connect(base);
    const firstMessages = collect(first);
    await opened(first);
    first.send(JSON.stringify({ v: 1, type: "stream.authenticate", ticket: reusableTicket }));
    await eventually(() =>
      firstMessages.json.some((message) => message.type === "stream.authenticated"),
    );
    first.close();

    const reused = connect(base);
    const reusedMessages = collect(reused);
    await opened(reused);
    reused.send(JSON.stringify({ v: 1, type: "stream.authenticate", ticket: reusableTicket }));
    await eventually(() =>
      reusedMessages.json.some((message) => message.code === "STREAM_AUTH_FAILED"),
    );

    const expiredTicket = await issueTicket(server);
    now += 51;
    const expired = connect(base);
    const expiredMessages = collect(expired);
    await opened(expired);
    expired.send(JSON.stringify({ v: 1, type: "stream.authenticate", ticket: expiredTicket }));
    await eventually(() =>
      expiredMessages.json.some((message) => message.code === "STREAM_TICKET_EXPIRED"),
    );

    for (const payload of [
      JSON.stringify({ v: 9, type: "stream.authenticate", ticket: "bad" }),
      "x".repeat(5_000),
    ]) {
      const socket = connect(base);
      const messages = collect(socket);
      await opened(socket);
      socket.send(payload);
      await eventually(() => socket.readyState === WebSocket.CLOSED || messages.json.length > 0);
      expect(
        socket.readyState === WebSocket.CLOSED || messages.json[0]?.type === "stream.error",
      ).toBe(true);
    }
  });
});

function createController(): BrowserController {
  const sessionId = "session-a" as SessionId;
  return {
    createSession: vi.fn(async (): Promise<SessionSnapshot> => ({ sessionId, state: "ready" })),
    getSession: vi.fn((): SessionSnapshot => ({ sessionId, state: "active" })),
    runProof: vi.fn(
      async (): Promise<ProofResult> => ({
        sessionId,
        state: "active",
        url: "",
        title: "",
        screenshotCaptured: true,
        screenshotBytes: 1,
      }),
    ),
    navigate: vi.fn(
      async (): Promise<NavigationResult> => ({ sessionId, state: "active", url: "", title: "" }),
    ),
    destroySession: vi.fn(async () => true),
    attachStream: vi.fn(async (_id: string, sink: ScreencastSink) => {
      sink.sendControl({
        v: 1,
        type: "frame.config",
        format: "jpeg",
        width: 1280,
        height: 720,
        dpr: 1,
      });
      await sink.sendBinary(
        encodeFrame(
          { sequence: 1, width: 1280, height: 720, format: "jpeg" },
          Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        ),
      );
    }),
    detachStream: vi.fn(async () => undefined),
    resizeViewport: vi.fn(async (_id: string, _viewport: ViewportSize) => undefined),
    dispatchInput: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  return address.replace(/^http/, "ws");
}

async function issueTicket(server: ReturnType<typeof createServer>): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/internal/browser-session/session-a/stream-ticket",
  });
  expect(response.statusCode).toBe(201);
  return response.json().ticket as string;
}

function connect(base: string): WebSocket {
  const socket = new WebSocket(`${base}/ws/browser`);
  sockets.push(socket);
  return socket;
}

function opened(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function collect(socket: WebSocket) {
  const result: { json: Record<string, unknown>[]; binary: Buffer[] } = { json: [], binary: [] };
  socket.on("message", (data, isBinary) => {
    if (isBinary) result.binary.push(Buffer.from(data as ArrayBuffer));
    else result.json.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  return result;
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
