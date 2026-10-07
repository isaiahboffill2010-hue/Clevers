import type { ClientStreamMessage, SessionId } from "@remote-browser/protocol";
import { type NavigationPolicy, NavigationPolicyError } from "@remote-browser/security";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import {
  BROWSER_VIEWPORT,
  ENABLE_NAVIGATION_DIAGNOSTICS,
  EXPECTED_TEST_SITE_TEXT,
  EXPECTED_TEST_SITE_TITLE,
  NAVIGATION_TIMEOUT_MS,
  SESSION_INITIALIZATION_TIMEOUT_MS,
} from "../config.js";
import { InputController } from "../input/input-controller.js";
import { SessionLifecycle } from "../sessions/session-lifecycle.js";
import type {
  ManagedSession,
  NavigationResult,
  ProofResult,
  SessionSnapshot,
  SessionState,
} from "../sessions/session-types.js";
import type { FrameTransportStats } from "../streaming/frame-transport.js";
import { ScreencastController, type ScreencastSink } from "../streaming/screencast-controller.js";
import type { ViewportSize } from "../streaming/viewport.js";

interface SessionLogger {
  info(data: object, message: string): void;
  warn(data: object, message: string): void;
  error(data: object, message: string): void;
}

interface BrowserSessionOptions {
  browser: Browser;
  id: SessionId;
  logger: SessionLogger;
  navigationPolicy: NavigationPolicy;
  targetUrl: string;
  onUnexpectedTermination: (session: BrowserSession) => void;
}

export class BrowserSession implements ManagedSession {
  readonly id: SessionId;
  readonly #browser: Browser;
  readonly #logger: SessionLogger;
  readonly #navigationPolicy: NavigationPolicy;
  readonly #targetUrl: string;
  readonly #onUnexpectedTermination: (session: BrowserSession) => void;
  readonly #lifecycle = new SessionLifecycle();
  #context: BrowserContext | undefined;
  #page: Page | undefined;
  #destroyPromise: Promise<void> | undefined;
  #handlingUnexpectedTermination = false;
  #navigationPolicyError: NavigationPolicyError | undefined;
  #lastSafeUrl: string | undefined;
  #screencast: ScreencastController | undefined;
  #input: InputController | undefined;

  constructor(options: BrowserSessionOptions) {
    this.id = options.id;
    this.#browser = options.browser;
    this.#logger = options.logger;
    this.#navigationPolicy = options.navigationPolicy;
    this.#targetUrl = options.targetUrl;
    this.#onUnexpectedTermination = options.onUnexpectedTermination;
  }

  get state(): SessionState {
    return this.#lifecycle.state;
  }

  async initialize(): Promise<void> {
    this.#lifecycle.transition("initializing");
    const startedAt = performance.now();

    try {
      await withTimeout(
        this.#createContextAndPage(),
        SESSION_INITIALIZATION_TIMEOUT_MS,
        "initialize",
      );
      this.#lifecycle.transition("ready");
      this.#logger.info(
        { sessionId: this.id, durationMs: Math.round(performance.now() - startedAt) },
        "browser session initialized",
      );
    } catch (error) {
      this.#lifecycle.transition("crashed");
      await this.#closeResources();
      throw error;
    }
  }

  async runProof(): Promise<ProofResult> {
    const navigation = await this.navigate(this.#targetUrl);
    const page = this.#requirePage();

    await page.getByText(EXPECTED_TEST_SITE_TEXT, { exact: true }).waitFor({
      state: "visible",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    if (navigation.title !== EXPECTED_TEST_SITE_TITLE) {
      throw new Error(`Unexpected controlled test title: ${navigation.title}`);
    }

    const screenshot = await page.screenshot({ type: "png" });
    if (screenshot.length === 0 || !isPng(screenshot)) {
      throw new Error("Chromium did not produce a valid PNG screenshot");
    }

    return {
      ...navigation,
      screenshotCaptured: true,
      screenshotBytes: screenshot.length,
    };
  }

  async navigate(input: string): Promise<NavigationResult> {
    if (this.state !== "ready" && this.state !== "active") {
      throw new Error(`Session ${this.id} cannot navigate from state ${this.state}`);
    }

    const approved = await this.#navigationPolicy.validate(input);
    const previousState = this.state;
    this.#lifecycle.transition("navigating");
    const startedAt = performance.now();
    const page = this.#requirePage();
    this.#navigationPolicyError = undefined;

    try {
      const response = await page.goto(approved.url, {
        timeout: NAVIGATION_TIMEOUT_MS,
        waitUntil: "load",
      });
      if (!response?.ok()) {
        const location = response?.headers().location;
        if (response && response.status() >= 300 && response.status() < 400 && location) {
          await this.#navigationPolicy.validate(new URL(location, response.url()).toString(), true);
        }
        throw new NavigationPolicyError(
          "NAVIGATION_FAILED",
          `The approved destination returned HTTP ${response?.status() ?? "unknown"}`,
        );
      }

      const title = await page.title();
      const finalUrl = page.url();
      await this.#navigationPolicy.validate(finalUrl, finalUrl !== approved.url);

      this.#lifecycle.transition("active");
      this.#lastSafeUrl = finalUrl;
      this.#logger.info(
        {
          sessionId: this.id,
          origin: new URL(finalUrl).origin,
          policyResult: "allowed",
          durationMs: Math.round(performance.now() - startedAt),
        },
        "policy-approved navigation succeeded",
      );

      return {
        sessionId: this.id,
        state: this.state,
        url: finalUrl,
        title,
      };
    } catch (error) {
      if ((this.state as SessionState) === "navigating") {
        this.#lifecycle.transition(previousState === "active" ? "active" : "ready");
      }
      const policyError = this.#navigationPolicyError as NavigationPolicyError | undefined;
      this.#navigationPolicyError = undefined;
      if (policyError && this.#lastSafeUrl) {
        await page.waitForTimeout(100);
        await page
          .goto(this.#lastSafeUrl, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "load" })
          .catch((restoreError: unknown) => {
            this.#logger.warn(
              { sessionId: this.id, error: restoreError },
              "failed to restore the last approved page after blocked navigation",
            );
          });
      }
      this.#logger.warn(
        {
          sessionId: this.id,
          origin: approved.origin,
          policyResult: policyError?.code ?? "NAVIGATION_FAILED",
          durationMs: Math.round(performance.now() - startedAt),
        },
        "policy-approved navigation failed",
      );
      if (policyError) throw policyError;
      if (error instanceof NavigationPolicyError) throw error;
      throw new NavigationPolicyError("NAVIGATION_FAILED", "The approved navigation failed", {
        cause: error,
      });
    }
  }

  snapshot(): SessionSnapshot {
    return { sessionId: this.id, state: this.state };
  }

  async attachStream(sink: ScreencastSink): Promise<void> {
    if (this.state === "closed" || this.state === "closing" || this.state === "crashed") {
      throw new Error("STREAM_SESSION_CLOSED");
    }
    if (this.#screencast) throw new Error("STREAM_ALREADY_CONNECTED");
    const controller = new ScreencastController({
      context: this.#requireContext(),
      page: this.#requirePage(),
      sessionId: this.id,
      sink,
      logger: this.#logger,
    });
    this.#screencast = controller;
    const input = new InputController(this.#requireContext(), this.#requirePage());
    this.#input = input;
    try {
      await input.start();
      await controller.start();
    } catch (error) {
      this.#screencast = undefined;
      this.#input = undefined;
      await input.stop();
      await controller.stop();
      throw error;
    }
  }

  async detachStream(): Promise<void> {
    const controller = this.#screencast;
    this.#screencast = undefined;
    const input = this.#input;
    this.#input = undefined;
    if (input) {
      await input.stop();
      this.#logger.info(
        { sessionId: this.id, ...input.metrics() },
        "remote input controller stopped",
      );
    }
    await controller?.stop();
  }

  async dispatchInput(
    message: Extract<ClientStreamMessage, { type: `input.${string}` }>,
  ): Promise<void> {
    const input = this.#input;
    if (!input) throw new Error("STREAM_NOT_CONNECTED");
    if ("x" in message && "y" in message) {
      const viewport = this.#requirePage().viewportSize();
      if (
        !viewport ||
        message.x < 0 ||
        message.y < 0 ||
        message.x >= viewport.width ||
        message.y >= viewport.height
      ) {
        throw new Error("STREAM_INVALID_INPUT");
      }
    }
    await input.dispatch(message);
  }

  async resizeViewport(viewport: ViewportSize): Promise<void> {
    const controller = this.#screencast;
    if (!controller) throw new Error("STREAM_NOT_CONNECTED");
    await controller.resize(viewport);
  }

  streamStats(): (Readonly<FrameTransportStats> & { approximateFps: number }) | undefined {
    return this.#screencast?.stats();
  }

  /** Integration-test hook. This is never exposed by the HTTP API. */
  async setStorageMarkerForTest(value: string): Promise<void> {
    await this.#requireContext().addCookies([
      { name: "phase2-isolation-marker", value, url: this.#targetUrl },
    ]);
    await this.#requirePage().evaluate((marker) => {
      localStorage.setItem("phase2-isolation-marker", marker);
    }, value);
  }

  /** Integration-test hook. This is never exposed by the HTTP API. */
  async readStorageMarkerForTest(): Promise<{ cookie: string; localStorage: string | null }> {
    const cookies = await this.#requireContext().cookies(this.#targetUrl);
    const localStorage = await this.#requirePage().evaluate(() =>
      globalThis.localStorage.getItem("phase2-isolation-marker"),
    );
    return {
      cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
      localStorage,
    };
  }

  /** Integration-test hook for deterministic unexpected-page-close handling. */
  async closePageForTest(): Promise<void> {
    await this.#requirePage().close();
  }

  async elementBoxForTest(selector: string) {
    return this.#requirePage().locator(selector).boundingBox();
  }

  async elementValueForTest(selector: string): Promise<string> {
    const locator = this.#requirePage().locator(selector);
    return locator.evaluate((element) => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
        return element.value;
      if (element instanceof HTMLElement && element.id === "scroller")
        return String(element.scrollTop);
      return element.textContent ?? "";
    });
  }

  async markCrashed(reason: string): Promise<void> {
    if (this.state === "closed" || this.state === "closing") return;
    if (this.state !== "crashed") this.#lifecycle.transition("crashed");
    this.#logger.error({ sessionId: this.id, reason }, "browser session crashed");
    await this.#closeResources();
  }

  async destroy(): Promise<void> {
    if (this.#destroyPromise) return this.#destroyPromise;
    if (this.state === "closed") return;

    this.#destroyPromise = this.#destroy();
    return this.#destroyPromise;
  }

  async #destroy(): Promise<void> {
    const startedAt = performance.now();
    if (this.state !== "closing") this.#lifecycle.transition("closing");
    await this.#closeResources();
    this.#lifecycle.transition("closed");
    this.#logger.info(
      { sessionId: this.id, durationMs: Math.round(performance.now() - startedAt) },
      "browser session closed",
    );
  }

  async #createContextAndPage(): Promise<void> {
    this.#context = await this.#browser.newContext({
      acceptDownloads: false,
      deviceScaleFactor: 1,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: BROWSER_VIEWPORT,
    });
    this.#page = await this.#context.newPage();
    await this.#installRedirectInterceptor(this.#page);
    if (ENABLE_NAVIGATION_DIAGNOSTICS) {
      this.#page.on("response", (response) => {
        if (response.status() < 400) return;
        this.#logger.warn(
          {
            sessionId: this.id,
            resourceType: response.request().resourceType(),
            ...safeUrlFields(response.url()),
            httpStatus: response.status(),
            policyStage: "chromium-response",
            errorCategory: "HTTP_ERROR_RESPONSE",
            policyBlocked: false,
          },
          "browser resource response failed",
        );
      });
      this.#page.on("requestfailed", (request) => {
        this.#logger.warn(
          {
            sessionId: this.id,
            resourceType: request.resourceType(),
            ...safeUrlFields(request.url()),
            policyStage: "chromium-network",
            errorCategory: networkFailureCategory(request.failure()?.errorText),
            policyBlocked: request.failure()?.errorText === "net::ERR_BLOCKED_BY_CLIENT",
          },
          "browser resource request failed",
        );
      });
      this.#page.on("pageerror", (error) => {
        this.#logger.warn(
          {
            sessionId: this.id,
            policyStage: "page-runtime",
            errorCategory: error.name || "PAGE_ERROR",
            policyBlocked: false,
          },
          "browser page runtime error",
        );
      });
      this.#page.on("console", (message) => {
        if (message.type() !== "error") return;
        const location = message.location();
        this.#logger.warn(
          {
            sessionId: this.id,
            resourceType: "console",
            ...safeUrlFields(location.url),
            policyStage: "page-console",
            errorCategory: "CONSOLE_ERROR",
            policyBlocked: false,
          },
          "browser page console error",
        );
      });
    }
    await this.#context.route("**/*", async (route) => {
      const request = route.request();
      const isMainNavigation =
        request.isNavigationRequest() && request.frame() === this.#page?.mainFrame();
      try {
        const protocol = safeProtocol(request.url());
        if (!isMainNavigation && isInternalNonNetworkProtocol(protocol)) {
          await route.continue();
          return;
        }
        await this.#navigationPolicy.validateNetworkRequest(
          request.url(),
          request.redirectedFrom() !== null,
        );
        await route.continue();
      } catch (error) {
        if (ENABLE_NAVIGATION_DIAGNOSTICS) {
          this.#logger.warn(
            {
              sessionId: this.id,
              resourceType: request.resourceType(),
              ...safeUrlFields(request.url()),
              policyStage: "browser-context-route",
              errorCategory:
                error instanceof NavigationPolicyError ? error.code : "RESOURCE_POLICY_FAILED",
              policyBlocked: true,
            },
            "browser resource request blocked",
          );
        }
        if (isMainNavigation && error instanceof NavigationPolicyError) {
          this.#navigationPolicyError = error;
        }
        await route.abort("blockedbyclient");
      }
    });
    await this.#context.routeWebSocket("**/*", async (webSocket) => {
      try {
        await this.#navigationPolicy.validateNetworkRequest(webSocket.url());
        webSocket.connectToServer();
      } catch (error) {
        if (ENABLE_NAVIGATION_DIAGNOSTICS) {
          this.#logger.warn(
            {
              sessionId: this.id,
              resourceType: "websocket",
              ...safeUrlFields(webSocket.url()),
              policyStage: "websocket-route",
              errorCategory:
                error instanceof NavigationPolicyError ? error.code : "RESOURCE_POLICY_FAILED",
              policyBlocked: true,
            },
            "browser resource request blocked",
          );
        }
        await webSocket.close({ code: 1008, reason: "Destination blocked" });
      }
    });
    this.#page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    this.#page.on("crash", () => this.#handleUnexpectedTermination("page crash"));
    this.#page.on("close", () => {
      if (this.state !== "closing" && this.state !== "closed" && this.state !== "crashed") {
        this.#handleUnexpectedTermination("page closed unexpectedly");
      }
    });
  }

  async #installRedirectInterceptor(page: Page): Promise<void> {
    const session = await this.#requireContext().newCDPSession(page);
    session.on("Fetch.requestPaused", (event: CdpResponsePausedEvent) => {
      void this.#handlePausedResponse(session, event);
    });
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }],
    });
  }

  async #handlePausedResponse(session: CDPSession, event: CdpResponsePausedEvent): Promise<void> {
    const location = event.responseHeaders?.find(
      (header) => header.name.toLowerCase() === "location",
    )?.value;
    const isRedirect =
      event.responseStatusCode !== undefined &&
      event.responseStatusCode >= 300 &&
      event.responseStatusCode < 400 &&
      location;
    try {
      if (isRedirect) {
        await this.#navigationPolicy.validateNetworkRequest(
          new URL(location, event.request.url).toString(),
          true,
        );
      }
      await session.send("Fetch.continueResponse", { requestId: event.requestId });
    } catch (error) {
      if (error instanceof NavigationPolicyError) this.#navigationPolicyError = error;
      if (ENABLE_NAVIGATION_DIAGNOSTICS) {
        this.#logger.warn(
          {
            sessionId: this.id,
            resourceType: "document",
            ...safeUrlFields(event.request.url),
            policyStage: "redirect-response",
            errorCategory:
              error instanceof NavigationPolicyError ? error.code : "RESOURCE_POLICY_FAILED",
            policyBlocked: true,
          },
          "browser redirect blocked",
        );
      }
      await session
        .send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })
        .catch(() => undefined);
    }
  }

  #handleUnexpectedTermination(reason: string): void {
    if (this.#handlingUnexpectedTermination) return;
    this.#handlingUnexpectedTermination = true;
    void this.markCrashed(reason)
      .catch((error: unknown) => {
        this.#logger.error({ sessionId: this.id, error }, "crash cleanup failed");
      })
      .finally(() => this.#onUnexpectedTermination(this));
  }

  async #closeResources(): Promise<void> {
    await this.detachStream().catch((error: unknown) => {
      this.#logger.warn({ sessionId: this.id, error }, "screencast cleanup failed");
    });
    const page = this.#page;
    const context = this.#context;
    this.#page = undefined;
    this.#context = undefined;

    const cleanupErrors: unknown[] = [];
    if (page && !page.isClosed()) {
      await page.close().catch((error: unknown) => cleanupErrors.push(error));
    }
    if (context) {
      await context.close().catch((error: unknown) => cleanupErrors.push(error));
    }
    if (cleanupErrors.length > 0) {
      this.#logger.warn(
        { sessionId: this.id, failureCount: cleanupErrors.length },
        "session resource cleanup encountered failures",
      );
    }
  }

  #requirePage(): Page {
    if (!this.#page) throw new Error(`Session ${this.id} has no active page`);
    return this.#page;
  }

  #requireContext(): BrowserContext {
    if (!this.#context) throw new Error(`Session ${this.id} has no active browser context`);
    return this.#context;
  }
}

function isPng(bytes: Buffer): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((byte, index) => bytes[index] === byte);
}

function safeUrlFields(input: string): {
  scheme: string;
  hostname: string;
  pathname?: string;
} {
  try {
    const url = new URL(input);
    return {
      scheme: url.protocol,
      hostname: url.hostname.toLowerCase().replace(/\.+$/, ""),
      pathname: url.pathname,
    };
  } catch {
    return { scheme: "invalid", hostname: "" };
  }
}

function networkFailureCategory(errorText: string | undefined): string {
  if (!errorText) return "NETWORK_REQUEST_FAILED";
  const category = errorText.match(/(?:net::)?ERR_[A-Z_]+/)?.[0];
  return category ?? "NETWORK_REQUEST_FAILED";
}

function safeProtocol(input: string): string {
  try {
    return new URL(input).protocol;
  } catch {
    return "invalid";
  }
}

function isInternalNonNetworkProtocol(protocol: string): boolean {
  return protocol === "blob:" || protocol === "data:" || protocol === "about:";
}

interface CdpResponsePausedEvent {
  requestId: string;
  request: { url: string };
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Browser session ${label} timed out`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
