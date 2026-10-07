"use client";

import { FRAME_HEADER_BYTES, mapContainedPoint } from "@remote-browser/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

const HTTP_BASE = process.env.NEXT_PUBLIC_BROWSER_SERVICE_HTTP ?? "http://127.0.0.1:3001";
const WS_BASE = process.env.NEXT_PUBLIC_BROWSER_SERVICE_WS ?? "ws://127.0.0.1:3001";
const DEFAULT_URL =
  process.env.NEXT_PUBLIC_BROWSER_INITIAL_URL ?? "http://127.0.0.1:3002/phase3/approved";

type ConnectionStatus = "starting" | "connecting" | "connected" | "disconnected" | "error";

export function RemoteViewport() {
  const [sessionId, setSessionId] = useState("");
  const [connection, setConnection] = useState<ConnectionStatus>("starting");
  const [sessionStatus, setSessionStatus] = useState("creating");
  const [url, setUrl] = useState(DEFAULT_URL);
  const [address, setAddress] = useState(DEFAULT_URL);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [metrics, setMetrics] = useState({ frames: 0, fps: 0, averageBytes: 0 });
  const [inputActive, setInputActive] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLButtonElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef("");
  const frameTimes = useRef<number[]>([]);
  const totalBytes = useRef(0);
  const frameSize = useRef({ width: 1280, height: 720 });
  const pendingMove = useRef<React.PointerEvent<HTMLButtonElement> | null>(null);
  const moveFrame = useRef<number | null>(null);

  const connectStream = useCallback(async (id: string) => {
    setConnection("connecting");
    setError("");
    const ticketResponse = await fetch(
      `${HTTP_BASE}/internal/browser-session/${id}/stream-ticket`,
      {
        method: "POST",
      },
    );
    if (!ticketResponse.ok) throw new Error("Could not obtain a stream ticket");
    const ticket = (await ticketResponse.json()) as { ticket: string };
    const socket = new WebSocket(`${WS_BASE}/ws/browser`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ v: 1, type: "stream.authenticate", ticket: ticket.ticket }));
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type === "stream.authenticated") {
          setConnection("connected");
          socket.send(JSON.stringify({ v: 1, type: "stream.ready" }));
        } else if (message.type === "page.urlChanged" && typeof message.url === "string") {
          setUrl(message.url);
        } else if (message.type === "page.titleChanged" && typeof message.title === "string") {
          setTitle(message.title);
        } else if (message.type === "page.loadingChanged") {
          setLoading(Boolean(message.loading));
        } else if (message.type === "stream.error") {
          setError(`${String(message.code)}: ${String(message.message)}`);
          setConnection("error");
        } else if (message.type === "page.crashed" || message.type === "browser.crashed") {
          setError("The remote page or browser crashed.");
          setSessionStatus("crashed");
        } else if (message.type === "session.closed") {
          setSessionStatus("closed");
        }
        return;
      }
      void renderFrame(event.data as ArrayBuffer);
    };
    socket.onclose = () => {
      if (socketRef.current === socket) setConnection("disconnected");
    };
    socket.onerror = () => setConnection("error");
  }, []);

  const renderFrame = useCallback(async (packet: ArrayBuffer) => {
    const view = new DataView(packet);
    if (packet.byteLength <= FRAME_HEADER_BYTES) return;
    const magic = String.fromCharCode(...new Uint8Array(packet, 0, 4));
    if (magic !== "RBV1" || view.getUint8(4) !== 1 || view.getUint8(5) !== 1) return;
    const headerBytes = view.getUint16(6);
    const sequence = view.getUint32(8);
    const width = view.getUint32(12);
    const height = view.getUint32(16);
    frameSize.current = { width, height };
    const blob = new Blob([packet.slice(headerBytes)], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
    }
    bitmap.close();
    const now = performance.now();
    frameTimes.current = [...frameTimes.current.filter((time) => now - time < 1_000), now];
    totalBytes.current += blob.size;
    setMetrics({
      frames: sequence,
      fps: frameTimes.current.length,
      averageBytes: Math.round(totalBytes.current / Math.max(sequence, 1)),
    });
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ v: 1, type: "frame.ack", sequence }));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    async function initialize() {
      try {
        const createdResponse = await fetch(`${HTTP_BASE}/internal/browser-session`, {
          method: "POST",
        });
        if (!createdResponse.ok) throw new Error("Could not create a browser session");
        const created = (await createdResponse.json()) as { sessionId: string; state: string };
        if (disposed) return;
        sessionRef.current = created.sessionId;
        setSessionId(created.sessionId);
        setSessionStatus(created.state);
        const navigationResponse = await fetch(
          `${HTTP_BASE}/internal/browser-session/${created.sessionId}/navigate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: DEFAULT_URL }),
          },
        );
        if (!navigationResponse.ok) throw new Error("Initial policy-approved navigation failed");
        const navigation = (await navigationResponse.json()) as {
          state: string;
          url: string;
          title: string;
        };
        setSessionStatus(navigation.state);
        setUrl(navigation.url);
        setTitle(navigation.title);
        await connectStream(created.sessionId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Remote viewport startup failed");
        setConnection("error");
      }
    }
    const startupTimer = setTimeout(() => void initialize(), 0);
    return () => {
      disposed = true;
      clearTimeout(startupTimer);
      socketRef.current?.close(1000, "viewport unmounted");
      const id = sessionRef.current;
      if (id)
        void fetch(`${HTTP_BASE}/internal/browser-session/${id}`, {
          method: "DELETE",
          keepalive: true,
        });
    };
  }, [connectStream]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const width = Math.max(320, Math.min(1920, Math.round(entry.contentRect.width)));
        const height = Math.max(240, Math.min(1080, Math.round(entry.contentRect.height)));
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ v: 1, type: "viewport.resize", width, height }));
        }
      }, 150);
    });
    observer.observe(element);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  async function navigate(event: React.FormEvent) {
    event.preventDefault();
    if (!sessionId) return;
    setLoading(true);
    const response = await fetch(`${HTTP_BASE}/internal/browser-session/${sessionId}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: address }),
    });
    const result = (await response.json()) as { error?: string; message?: string };
    if (!response.ok) setError(`${result.error ?? "NAVIGATION_FAILED"}: ${result.message ?? ""}`);
  }

  async function destroySession() {
    if (!sessionId) return;
    socketRef.current?.close(1000, "session destroyed");
    const response = await fetch(`${HTTP_BASE}/internal/browser-session/${sessionId}`, {
      method: "DELETE",
    });
    if (response.ok) {
      sessionRef.current = "";
      setSessionStatus("closed");
      setConnection("disconnected");
    }
  }

  function sendInput(message: Record<string, unknown>) {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, ...message }));
  }

  function mappedPoint(event: { clientX: number; clientY: number }) {
    const element = viewportRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    return mapContainedPoint(
      event.clientX,
      event.clientY,
      rect,
      frameSize.current.width,
      frameSize.current.height,
    );
  }

  function modifiers(event: {
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }) {
    return (
      (event.altKey ? 1 : 0) |
      (event.ctrlKey ? 2 : 0) |
      (event.metaKey ? 4 : 0) |
      (event.shiftKey ? 8 : 0)
    );
  }

  function pointerButton(button: number) {
    return button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : undefined;
  }

  function activateInput() {
    viewportRef.current?.focus();
    setInputActive(true);
    sendInput({ type: "input.focus" });
  }

  function releaseInput() {
    setInputActive(false);
    sendInput({ type: "input.blur" });
  }

  function onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    pendingMove.current = event;
    if (moveFrame.current !== null) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null;
      const latest = pendingMove.current;
      pendingMove.current = null;
      if (!latest) return;
      const point = mappedPoint(latest);
      if (point)
        sendInput({
          type: "input.pointerMove",
          ...point,
          buttons: latest.buttons,
          modifiers: modifiers(latest),
        });
    });
  }

  function onPointerButton(
    event: React.PointerEvent<HTMLButtonElement>,
    type: "input.pointerDown" | "input.pointerUp",
  ) {
    const point = mappedPoint(event);
    const button = pointerButton(event.button);
    if (!point || !button) return;
    event.preventDefault();
    if (type === "input.pointerDown") {
      activateInput();
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    sendInput({
      type,
      ...point,
      button,
      buttons: event.buttons,
      clickCount: Math.max(1, event.detail),
      modifiers: modifiers(event),
    });
  }

  function onWheel(event: React.WheelEvent<HTMLButtonElement>) {
    const point = mappedPoint(event);
    if (!point || !inputActive) return;
    event.preventDefault();
    sendInput({
      type: "input.wheel",
      ...point,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: modifiers(event),
    });
  }

  function onKey(
    event: React.KeyboardEvent<HTMLButtonElement>,
    type: "input.keyDown" | "input.keyUp",
  ) {
    if (!inputActive) return;
    if (event.ctrlKey && event.altKey && event.shiftKey && event.key === "Escape") {
      event.preventDefault();
      releaseInput();
      viewportRef.current?.blur();
      return;
    }
    event.preventDefault();
    sendInput({
      type,
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      location: event.location,
      modifiers: modifiers(event),
    });
    if (
      type === "input.keyDown" &&
      !event.repeat &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      event.key.length === 1 &&
      !event.nativeEvent.isComposing
    ) {
      sendInput({ type: "input.insertText", text: event.key });
    }
  }

  return (
    <main className="browser-shell">
      <header className="browser-header">
        <div>
          <p className="eyebrow">Display-only session</p>
          <h1>Remote Browser</h1>
        </div>
        <div>
          <button
            type="button"
            onClick={() => sessionId && connectStream(sessionId)}
            disabled={!sessionId || connection === "connected"}
          >
            Reconnect stream
          </button>
          <button
            type="button"
            onClick={() => socketRef.current?.close(1000, "viewer disconnected")}
            disabled={connection !== "connected"}
          >
            Disconnect stream
          </button>
          <button type="button" onClick={destroySession} disabled={!sessionId}>
            Destroy session
          </button>
        </div>
      </header>
      <section className="status-grid" aria-live="polite">
        <span>Connection: {connection}</span>
        <span>Session: {sessionStatus}</span>
        <span>Loading: {loading ? "yes" : "no"}</span>
        <span>
          Frames: {metrics.frames} · {metrics.fps} fps · {metrics.averageBytes} avg bytes
        </span>
        <span>Input: {inputActive ? "active" : "click viewport to control"}</span>
      </section>
      <form className="address-form" onSubmit={navigate}>
        <label htmlFor="address">Allowlisted URL</label>
        <div>
          <input
            id="address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <button type="submit">Navigate</button>
        </div>
      </form>
      <section className="page-state">
        <strong>{title || "Untitled page"}</strong>
        <span>{url}</span>
      </section>
      {error ? <p className="error-banner">{error}</p> : null}
      <button
        type="button"
        className={`viewport-frame${inputActive ? " input-active" : ""}`}
        ref={viewportRef}
        aria-label="Remote browser viewport"
        onPointerMove={onPointerMove}
        onPointerDown={(event) => onPointerButton(event, "input.pointerDown")}
        onPointerUp={(event) => onPointerButton(event, "input.pointerUp")}
        onPointerCancel={releaseInput}
        onWheel={onWheel}
        onKeyDown={(event) => onKey(event, "input.keyDown")}
        onKeyUp={(event) => onKey(event, "input.keyUp")}
        onBlur={releaseInput}
        onContextMenu={(event) => event.preventDefault()}
        onPaste={(event) => {
          if (!inputActive) return;
          event.preventDefault();
          sendInput({ type: "input.insertText", text: event.clipboardData.getData("text/plain") });
        }}
        onCompositionEnd={(event) => {
          if (inputActive && event.data) sendInput({ type: "input.insertText", text: event.data });
        }}
      >
        <canvas ref={canvasRef} />
        {connection !== "connected" ? <span className="viewport-overlay">{connection}</span> : null}
      </button>
    </main>
  );
}
