import type { ServerStreamMessage } from "@remote-browser/protocol";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { SCREENCAST_CONFIG } from "../config.js";
import { type FrameTransportStats, LatestFrameTransport } from "./frame-transport.js";
import type { ViewportSize } from "./viewport.js";

interface StreamLogger {
  info(data: object, message: string): void;
  warn(data: object, message: string): void;
}

export interface ScreencastSink {
  sendBinary(packet: Buffer): Promise<void>;
  sendControl(message: ServerStreamMessage): void;
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
  metadata: { deviceWidth?: number; deviceHeight?: number };
}

export class ScreencastController {
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #sessionId: string;
  readonly #sink: ScreencastSink;
  readonly #logger: StreamLogger;
  readonly #transport: LatestFrameTransport;
  #cdp: CDPSession | undefined;
  #sequence = 0;
  #startedAt = 0;
  #stopping = false;

  constructor(options: {
    context: BrowserContext;
    page: Page;
    sessionId: string;
    sink: ScreencastSink;
    logger: StreamLogger;
  }) {
    this.#context = options.context;
    this.#page = options.page;
    this.#sessionId = options.sessionId;
    this.#sink = options.sink;
    this.#logger = options.logger;
    this.#transport = new LatestFrameTransport((packet) => this.#sink.sendBinary(packet));
  }

  async start(): Promise<void> {
    if (this.#cdp) return;
    this.#startedAt = performance.now();
    const cdp = await this.#context.newCDPSession(this.#page);
    this.#cdp = cdp;
    cdp.on("Page.screencastFrame", (event: ScreencastFrameEvent) => this.#onFrame(event));
    this.#page.on("framenavigated", this.#onFrameNavigated);
    this.#page.on("load", this.#onLoad);
    this.#page.on("domcontentloaded", this.#onDomContentLoaded);
    this.#page.on("crash", this.#onCrash);
    this.#page.on("close", this.#onPageClose);

    const viewport = this.#page.viewportSize();
    if (!viewport) throw new Error("Screencast requires a fixed viewport");
    this.#sendConfig(viewport);
    this.#sendPageState();
    await cdp.send("Page.startScreencast", SCREENCAST_CONFIG);
    this.#logger.info({ sessionId: this.#sessionId }, "CDP screencast started");
  }

  async resize(viewport: ViewportSize): Promise<void> {
    await this.#page.setViewportSize(viewport);
    this.#sendConfig(viewport);
    this.#logger.info({ sessionId: this.#sessionId, ...viewport }, "remote viewport resized");
  }

  stats(): Readonly<FrameTransportStats> & { approximateFps: number } {
    const stats = this.#transport.snapshot();
    const elapsedSeconds = Math.max((performance.now() - this.#startedAt) / 1000, 0.001);
    return { ...stats, approximateFps: stats.framesSent / elapsedSeconds };
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#transport.close();
    this.#removePageListeners();
    const cdp = this.#cdp;
    this.#cdp = undefined;
    if (cdp) {
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
    const stats = this.stats();
    this.#logger.info({ sessionId: this.#sessionId, ...stats }, "CDP screencast stopped");
  }

  #onFrame(event: ScreencastFrameEvent): void {
    const cdp = this.#cdp;
    if (!cdp) return;
    const jpeg = Buffer.from(event.data, "base64");
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch((error) => {
      this.#logger.warn({ sessionId: this.#sessionId, error }, "screencast frame ack failed");
    });
    const viewport = this.#page.viewportSize();
    const width = Math.round(event.metadata.deviceWidth ?? viewport?.width ?? 0);
    const height = Math.round(event.metadata.deviceHeight ?? viewport?.height ?? 0);
    this.#sequence += 1;
    this.#transport.enqueue({ sequence: this.#sequence, width, height, jpeg });
  }

  readonly #onFrameNavigated = (frame: { url(): string; parentFrame(): unknown }) => {
    if (frame.parentFrame() !== null) return;
    this.#sink.sendControl({ v: 1, type: "page.urlChanged", url: frame.url() });
    void this.#page.title().then((title) => {
      this.#sink.sendControl({ v: 1, type: "page.titleChanged", title });
    });
  };

  readonly #onLoad = () => {
    this.#sink.sendControl({ v: 1, type: "page.loadingChanged", loading: false });
    void this.#page.title().then((title) => {
      this.#sink.sendControl({ v: 1, type: "page.titleChanged", title });
    });
  };

  readonly #onDomContentLoaded = () => {
    this.#sink.sendControl({ v: 1, type: "page.loadingChanged", loading: true });
  };

  readonly #onCrash = () => this.#sink.sendControl({ v: 1, type: "page.crashed" });
  readonly #onPageClose = () => this.#sink.sendControl({ v: 1, type: "session.closed" });

  #sendConfig(viewport: ViewportSize): void {
    this.#sink.sendControl({
      v: 1,
      type: "frame.config",
      format: "jpeg",
      width: viewport.width,
      height: viewport.height,
      dpr: 1,
    });
  }

  #sendPageState(): void {
    this.#sink.sendControl({ v: 1, type: "page.urlChanged", url: this.#page.url() });
    void this.#page.title().then((title) => {
      this.#sink.sendControl({ v: 1, type: "page.titleChanged", title });
    });
  }

  #removePageListeners(): void {
    this.#page.off("framenavigated", this.#onFrameNavigated);
    this.#page.off("load", this.#onLoad);
    this.#page.off("domcontentloaded", this.#onDomContentLoaded);
    this.#page.off("crash", this.#onCrash);
    this.#page.off("close", this.#onPageClose);
  }
}
