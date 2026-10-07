import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NavigationPolicyError } from "@remote-browser/security";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createServer } from "../server/create-server.js";
import { decodeFrame } from "../streaming/frame-protocol.js";
import { BrowserManager } from "./browser-manager.js";

const TEST_SITE_PORT = 3212;
const TEST_SITE_URL = `http://127.0.0.1:${TEST_SITE_PORT}`;
const testSiteDirectory = fileURLToPath(new URL("../../../test-site/", import.meta.url));
const nextBinary = fileURLToPath(
  new URL("../../../test-site/node_modules/next/dist/bin/next", import.meta.url),
);
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let testSite: ChildProcess;
const managers: BrowserManager[] = [];

beforeAll(async () => {
  testSite = spawn(
    process.execPath,
    [nextBinary, "start", "--hostname", "127.0.0.1", "--port", String(TEST_SITE_PORT)],
    { cwd: testSiteDirectory, stdio: "ignore", windowsHide: true },
  );
  await waitForUrl(`${TEST_SITE_URL}/api/health`);
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
});

afterAll(async () => {
  if (testSite && !testSite.killed) {
    testSite.kill("SIGTERM");
    await waitForExit(testSite);
  }
});

function createManager(): BrowserManager {
  const manager = new BrowserManager({ logger: silentLogger, targetUrl: TEST_SITE_URL });
  managers.push(manager);
  return manager;
}

describe("real Chromium browser lifecycle", () => {
  it("loads the controlled site and captures an in-memory PNG", async () => {
    const manager = createManager();
    const created = await manager.createSession();
    expect(created.state).toBe("ready");

    const session = manager.getSessionForTest(created.sessionId);
    const proof = await manager.runProof(created.sessionId);
    expect(proof).toMatchObject({
      state: "active",
      title: "Remote Browser Test Site",
      screenshotCaptured: true,
    });
    expect(proof.url).toBe(`${TEST_SITE_URL}/`);
    expect(proof.screenshotBytes).toBeGreaterThan(0);

    expect(await manager.destroySession(created.sessionId)).toBe(true);
    expect(await manager.destroySession(created.sessionId)).toBe(false);
    expect(session.state).toBe("closed");
    expect(manager.activeSessionCount).toBe(0);
  });

  it("does not preserve cookie or localStorage data between sequential contexts", async () => {
    const manager = createManager();
    const first = await manager.createSession();
    await manager.runProof(first.sessionId);
    await manager.getSessionForTest(first.sessionId).setStorageMarkerForTest("session-a");
    expect(await manager.destroySession(first.sessionId)).toBe(true);

    const second = await manager.createSession();
    await manager.runProof(second.sessionId);
    const marker = await manager.getSessionForTest(second.sessionId).readStorageMarkerForTest();
    expect(marker.localStorage).toBeNull();
    expect(marker.cookie).not.toContain("phase2-isolation-marker");
    await manager.destroySession(second.sessionId);
  });

  it("completes ten create, navigate, and destroy iterations without registry growth", async () => {
    const manager = createManager();
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const session = await manager.createSession();
      await manager.runProof(session.sessionId);
      await manager.destroySession(session.sessionId);
      expect(manager.activeSessionCount).toBe(0);
    }
  });

  it("marks and removes a session when its page closes unexpectedly", async () => {
    const manager = createManager();
    const created = await manager.createSession();
    const session = manager.getSessionForTest(created.sessionId);
    await session.closePageForTest();
    await expectEventually(() => manager.activeSessionCount === 0);
    expect(session.state).toBe("crashed");
  });

  it("allows approved navigation and approved same-origin redirects", async () => {
    const manager = createManager();
    const created = await manager.createSession();
    const direct = await manager.navigate(created.sessionId, `${TEST_SITE_URL}/phase3/approved`);
    expect(direct).toMatchObject({ title: "Phase 3 Approved Destination", state: "active" });

    const redirected = await manager.navigate(
      created.sessionId,
      `${TEST_SITE_URL}/api/phase3/redirect-approved`,
    );
    expect(redirected.url).toBe(`${TEST_SITE_URL}/phase3/approved`);
    expect(redirected.title).toBe("Phase 3 Approved Destination");
  });

  it("rejects blocked inputs before Chromium and keeps the session usable", async () => {
    const manager = createManager();
    const created = await manager.createSession();
    await manager.runProof(created.sessionId);

    for (const [url, code] of [
      ["https://adult.example/", "NAVIGATION_CONTENT_BLOCKED"],
      ["http://10.0.0.1/", "NAVIGATION_PRIVATE_ADDRESS"],
      ["http://169.254.169.254/", "NAVIGATION_PRIVATE_ADDRESS"],
      ["file:///etc/passwd", "NAVIGATION_SCHEME_BLOCKED"],
    ] as const) {
      await expect(manager.navigate(created.sessionId, url)).rejects.toMatchObject({ code });
      expect(manager.getSession(created.sessionId).state).toBe("active");
    }

    const recovered = await manager.navigate(created.sessionId, `${TEST_SITE_URL}/phase3/approved`);
    expect(recovered.state).toBe("active");
  });

  it("blocks redirect escapes and remains reusable", async () => {
    const manager = createManager();
    const created = await manager.createSession();
    await manager.runProof(created.sessionId);

    for (const path of [
      "/api/phase3/redirect-blocked-host",
      "/api/phase3/redirect-private",
      "/api/phase3/redirect-unsafe",
    ]) {
      const error = await manager
        .navigate(created.sessionId, `${TEST_SITE_URL}${path}`)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NavigationPolicyError);
      expect(error).toMatchObject({ code: "NAVIGATION_REDIRECT_BLOCKED" });
      expect(manager.getSession(created.sessionId).state).toBe("active");
    }

    const recovered = await manager.navigate(created.sessionId, `${TEST_SITE_URL}/phase3/approved`);
    expect(recovered.state).toBe("active");
  });

  it("fails a redirect loop without destroying the session", async () => {
    const manager = createManager();
    const created = await manager.createSession();
    await expect(
      manager.navigate(created.sessionId, `${TEST_SITE_URL}/api/phase3/redirect-loop`),
    ).rejects.toMatchObject({ code: "NAVIGATION_FAILED" });
    expect(manager.getSession(created.sessionId).state).toBe("ready");
  });

  it("streams real JPEG frames, resizes, detaches, and reconnects", async () => {
    const manager = createManager();
    const created = await manager.createSession();
    await manager.navigate(created.sessionId, `${TEST_SITE_URL}/phase3/approved`);
    const packets: Buffer[] = [];
    const controls: Array<{ type: string; width?: number; height?: number }> = [];
    await manager.attachStream(created.sessionId, {
      sendBinary: async (packet) => {
        packets.push(packet);
      },
      sendControl: (message) => {
        controls.push(message);
      },
    });
    await expectEventually(() => packets.length > 0);
    const first = decodeFrame(packets[0] as Buffer);
    expect(first.jpeg.length).toBeGreaterThan(0);
    expect(first.jpeg[0]).toBe(0xff);
    expect(first.jpeg[1]).toBe(0xd8);

    await manager.resizeViewport(created.sessionId, { width: 800, height: 600 });
    await expectEventually(() =>
      controls.some(
        (event) => event.type === "frame.config" && event.width === 800 && event.height === 600,
      ),
    );
    await manager.detachStream(created.sessionId);

    const reconnected: Buffer[] = [];
    await manager.attachStream(created.sessionId, {
      sendBinary: async (packet) => {
        reconnected.push(packet);
      },
      sendControl: () => undefined,
    });
    await expectEventually(() => reconnected.length > 0);
    await manager.detachStream(created.sessionId);
    await manager.destroySession(created.sessionId);
  });

  it("delivers real Chromium frames over an authenticated WebSocket and reconnects", async () => {
    const manager = createManager();
    const server = createServer({ browserController: manager });
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const wsAddress = address.replace(/^http/, "ws");
    try {
      const createResponse = await fetch(`${address}/internal/browser-session`, { method: "POST" });
      const created = (await createResponse.json()) as { sessionId: string };
      await fetch(`${address}/internal/browser-session/${created.sessionId}/navigate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${TEST_SITE_URL}/phase3/approved` }),
      });

      const first = await connectAuthenticated(address, wsAddress, created.sessionId);
      await expectEventually(() => first.binary.length > 0);
      expect(decodeFrame(first.binary[0] as Buffer).jpeg.length).toBeGreaterThan(0);
      first.socket.close(1000, "integration reconnect");
      await waitForSocketClose(first.socket);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const second = await connectAuthenticated(address, wsAddress, created.sessionId);
      await expectEventually(() => second.binary.length > 0);
      second.socket.close(1000, "integration complete");
      await waitForSocketClose(second.socket);

      const destroyed = await fetch(`${address}/internal/browser-session/${created.sessionId}`, {
        method: "DELETE",
      });
      expect((await destroyed.json()) as { destroyed: boolean }).toMatchObject({ destroyed: true });
    } finally {
      await server.close();
    }
  });

  it("forwards raw mouse, keyboard, text, wheel, drag, double-click, and right-click input", async () => {
    const manager = createManager();
    const created = await manager.createSession();
    await manager.navigate(created.sessionId, `${TEST_SITE_URL}/phase5/input`);
    await manager.attachStream(created.sessionId, {
      sendBinary: async () => undefined,
      sendControl: () => undefined,
    });
    const session = manager.getSessionForTest(created.sessionId);
    await manager.dispatchInput(created.sessionId, { v: 1, type: "input.focus" });
    const sendClick = async (
      selector: string,
      button: "left" | "right" = "left",
      clickCount = 1,
    ) => {
      const box = await session.elementBoxForTest(selector);
      if (!box) throw new Error(`Missing fixture element ${selector}`);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await manager.dispatchInput(created.sessionId, {
        v: 1,
        type: "input.pointerDown",
        x,
        y,
        button,
        buttons: button === "left" ? 1 : 2,
        clickCount,
        modifiers: 0,
      });
      await manager.dispatchInput(created.sessionId, {
        v: 1,
        type: "input.pointerUp",
        x,
        y,
        button,
        buttons: 0,
        clickCount,
        modifiers: 0,
      });
    };
    await sendClick("#click-target");
    expect(await session.elementValueForTest("#status")).toMatch(/^click:/);
    await sendClick("#click-target", "left", 1);
    await sendClick("#click-target", "left", 2);
    expect(await session.elementValueForTest("#status")).toBe("double-click");
    await sendClick("#click-target", "right");
    expect(await session.elementValueForTest("#status")).toBe("context-menu");

    await sendClick("#text-input");
    for (const [key, code] of [
      ["H", "KeyH"],
      ["i", "KeyI"],
    ] as const) {
      await manager.dispatchInput(created.sessionId, {
        v: 1,
        type: "input.keyDown",
        key,
        code,
        repeat: false,
        location: 0,
        modifiers: key === "H" ? 8 : 0,
      });
      await manager.dispatchInput(created.sessionId, { v: 1, type: "input.insertText", text: key });
      await manager.dispatchInput(created.sessionId, {
        v: 1,
        type: "input.keyUp",
        key,
        code,
        repeat: false,
        location: 0,
        modifiers: 0,
      });
    }
    expect(await session.elementValueForTest("#text-input")).toBe("Hi");
    await manager.dispatchInput(created.sessionId, {
      v: 1,
      type: "input.keyDown",
      key: "Backspace",
      code: "Backspace",
      repeat: false,
      location: 0,
      modifiers: 0,
    });
    await manager.dispatchInput(created.sessionId, {
      v: 1,
      type: "input.keyUp",
      key: "Backspace",
      code: "Backspace",
      repeat: false,
      location: 0,
      modifiers: 0,
    });
    expect(await session.elementValueForTest("#text-input")).toBe("H");

    const scroll = await session.elementBoxForTest("#scroller");
    if (!scroll) throw new Error("Missing scroller");
    await manager.dispatchInput(created.sessionId, {
      v: 1,
      type: "input.wheel",
      x: scroll.x + 20,
      y: scroll.y + 20,
      deltaX: 0,
      deltaY: 100,
      modifiers: 0,
    });
    await expectEventually(async () => Number(await session.elementValueForTest("#scroller")) > 0);
    const drag = await session.elementBoxForTest("#drag-target");
    if (!drag) throw new Error("Missing drag target");
    const x = drag.x + 20;
    const y = drag.y + 20;
    await manager.dispatchInput(created.sessionId, {
      v: 1,
      type: "input.pointerDown",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    });
    await manager.dispatchInput(created.sessionId, {
      v: 1,
      type: "input.pointerMove",
      x: x + 30,
      y: y + 10,
      buttons: 1,
      modifiers: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await manager.dispatchInput(created.sessionId, {
      v: 1,
      type: "input.pointerUp",
      x: x + 30,
      y: y + 10,
      button: "left",
      buttons: 0,
      clickCount: 1,
      modifiers: 0,
    });
    expect(await session.elementValueForTest("#status")).toBe("drag-end");
    await manager.detachStream(created.sessionId);
  });
});

async function connectAuthenticated(httpAddress: string, wsAddress: string, sessionId: string) {
  const ticketResponse = await fetch(
    `${httpAddress}/internal/browser-session/${sessionId}/stream-ticket`,
    { method: "POST" },
  );
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const socket = new WebSocket(`${wsAddress}/ws/browser`);
  const json: Array<Record<string, unknown>> = [];
  const binary: Buffer[] = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) binary.push(Buffer.from(data as ArrayBuffer));
    else json.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ v: 1, type: "stream.authenticate", ticket }));
  await expectEventually(() => json.some((message) => message.type === "stream.authenticated"));
  return { socket, json, binary };
}

function waitForSocketClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

async function waitForUrl(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The controlled test site is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for controlled test site: ${url}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000),
  ]);
}

async function expectEventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  expect(await predicate()).toBe(true);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
