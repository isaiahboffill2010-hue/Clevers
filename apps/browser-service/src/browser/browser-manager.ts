import type { ClientStreamMessage } from "@remote-browser/protocol";
import type { NavigationPolicy } from "@remote-browser/security";
import { type Browser, chromium } from "playwright";
import { BROWSER_TEST_TARGET_URL } from "../config.js";
import { createNavigationPolicy } from "../navigation/create-navigation-policy.js";
import { SessionRegistry } from "../sessions/session-registry.js";
import type { NavigationResult, ProofResult, SessionSnapshot } from "../sessions/session-types.js";
import type { ScreencastSink } from "../streaming/screencast-controller.js";
import type { ViewportSize } from "../streaming/viewport.js";
import { BrowserSession } from "./browser-session.js";

interface ManagerLogger {
  info(data: object, message: string): void;
  warn(data: object, message: string): void;
  error(data: object, message: string): void;
}

interface BrowserManagerOptions {
  logger: ManagerLogger;
  targetUrl?: string;
  navigationPolicy?: NavigationPolicy;
}

export class BrowserManager {
  readonly #logger: ManagerLogger;
  readonly #targetUrl: string;
  readonly #navigationPolicy: NavigationPolicy;
  readonly #registry = new SessionRegistry();
  #browser: Browser | undefined;
  #launchPromise: Promise<Browser> | undefined;
  #shuttingDown = false;

  constructor(options: BrowserManagerOptions) {
    this.#logger = options.logger;
    this.#targetUrl = options.targetUrl ?? BROWSER_TEST_TARGET_URL;
    this.#navigationPolicy = options.navigationPolicy ?? createNavigationPolicy(this.#targetUrl);
  }

  get activeSessionCount(): number {
    return this.#registry.size;
  }

  async createSession(): Promise<SessionSnapshot> {
    if (this.#shuttingDown) throw new Error("Browser service is shutting down");
    const browser = await this.#getBrowser();
    const id = this.#registry.createId();
    const session = new BrowserSession({
      browser,
      id,
      logger: this.#logger,
      navigationPolicy: this.#navigationPolicy,
      targetUrl: this.#targetUrl,
      onUnexpectedTermination: (terminated) => this.#registry.remove(terminated.id),
    });

    this.#registry.register(session);
    try {
      await session.initialize();
      this.#logger.info({ sessionId: id }, "browser session created");
      return session.snapshot();
    } catch (error) {
      this.#registry.remove(id);
      throw error;
    }
  }

  getSession(id: string): SessionSnapshot {
    return this.#registry.get(id).snapshot();
  }

  async runProof(id: string): Promise<ProofResult> {
    const session = this.#registry.get(id);
    if (!(session instanceof BrowserSession)) throw new Error("Unexpected session implementation");
    return session.runProof();
  }

  async navigate(id: string, url: string): Promise<NavigationResult> {
    const session = this.#registry.get(id);
    if (!(session instanceof BrowserSession)) throw new Error("Unexpected session implementation");
    return session.navigate(url);
  }

  async attachStream(id: string, sink: ScreencastSink): Promise<void> {
    const session = this.#requireBrowserSession(id);
    await session.attachStream(sink);
  }

  async detachStream(id: string): Promise<void> {
    const session = this.#requireBrowserSession(id);
    await session.detachStream();
  }

  async resizeViewport(id: string, viewport: ViewportSize): Promise<void> {
    const session = this.#requireBrowserSession(id);
    await session.resizeViewport(viewport);
  }

  async dispatchInput(
    id: string,
    message: Extract<ClientStreamMessage, { type: `input.${string}` }>,
  ): Promise<void> {
    await this.#requireBrowserSession(id).dispatchInput(message);
  }

  async destroySession(id: string): Promise<boolean> {
    return this.#registry.destroy(id);
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    await this.#registry.destroyAll();
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser?.isConnected()) await browser.close();
    this.#logger.info({}, "browser manager shut down");
  }

  /** Test-only access for real-browser lifecycle assertions; not exposed through HTTP. */
  getSessionForTest(id: string): BrowserSession {
    return this.#requireBrowserSession(id);
  }

  #requireBrowserSession(id: string): BrowserSession {
    const session = this.#registry.get(id);
    if (!(session instanceof BrowserSession)) throw new Error("Unexpected session implementation");
    return session;
  }

  async #getBrowser(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    if (this.#launchPromise) return this.#launchPromise;

    this.#launchPromise = this.#launchBrowser();
    try {
      this.#browser = await this.#launchPromise;
      return this.#browser;
    } finally {
      this.#launchPromise = undefined;
    }
  }

  async #launchBrowser(): Promise<Browser> {
    const startedAt = performance.now();
    const browser = await chromium.launch({ headless: true });
    browser.on("disconnected", () => {
      if (this.#browser === browser) this.#browser = undefined;
      if (this.#shuttingDown) return;
      this.#logger.error({}, "Chromium disconnected unexpectedly");
      void this.#registry.handleBrowserDisconnected().catch((error: unknown) => {
        this.#logger.error({ error }, "browser disconnect cleanup failed");
      });
    });
    this.#logger.info(
      { durationMs: Math.round(performance.now() - startedAt), version: browser.version() },
      "Chromium launched",
    );
    return browser;
  }
}
