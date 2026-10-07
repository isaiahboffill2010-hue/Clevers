export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

declare const identifierBrand: unique symbol;
type Identifier<Kind extends string> = string & { readonly [identifierBrand]: Kind };

export type SessionId = Identifier<"SessionId">;
export type TabId = Identifier<"TabId">;
export type RequestId = Identifier<"RequestId">;

export interface NavigateRequest {
  url: string;
}

export type NavigationErrorCode =
  | "NAVIGATION_INVALID_URL"
  | "NAVIGATION_SCHEME_BLOCKED"
  | "NAVIGATION_CREDENTIALS_BLOCKED"
  | "NAVIGATION_CONTENT_BLOCKED"
  | "NAVIGATION_PORT_NOT_ALLOWED"
  | "NAVIGATION_PRIVATE_ADDRESS"
  | "NAVIGATION_DNS_FAILED"
  | "NAVIGATION_REDIRECT_BLOCKED"
  | "NAVIGATION_FAILED";

export interface NavigateSuccess {
  ok: true;
  sessionId: SessionId;
  url: string;
  title: string;
  status: "active";
}

export interface NavigationErrorResponse {
  ok: false;
  error: NavigationErrorCode;
  message: string;
}

export const STREAM_PROTOCOL_VERSION = 1 as const;
export const FRAME_HEADER_BYTES = 20 as const;

export type StreamErrorCode =
  | "STREAM_AUTH_FAILED"
  | "STREAM_TICKET_EXPIRED"
  | "STREAM_SESSION_NOT_FOUND"
  | "STREAM_SESSION_CLOSED"
  | "STREAM_PROTOCOL_MISMATCH"
  | "STREAM_ALREADY_CONNECTED"
  | "STREAM_INVALID_MESSAGE"
  | "STREAM_INTERNAL_ERROR";

export type ClientStreamMessage =
  | { v: 1; type: "stream.authenticate"; ticket: string }
  | { v: 1; type: "stream.ready" }
  | { v: 1; type: "frame.ack"; sequence: number }
  | { v: 1; type: "viewport.resize"; width: number; height: number }
  | { v: 1; type: "session.ping"; timestamp?: number }
  | PointerMoveMessage
  | PointerButtonMessage
  | WheelMessage
  | KeyMessage
  | { v: 1; type: "input.insertText"; text: string }
  | { v: 1; type: "input.focus" }
  | { v: 1; type: "input.blur" };

export type InputModifiers = number;
export type PointerButton = "none" | "left" | "middle" | "right";

export interface PointerMoveMessage {
  v: 1;
  type: "input.pointerMove";
  x: number;
  y: number;
  buttons: number;
  modifiers: InputModifiers;
}

export interface PointerButtonMessage {
  v: 1;
  type: "input.pointerDown" | "input.pointerUp";
  x: number;
  y: number;
  button: PointerButton;
  buttons: number;
  clickCount: number;
  modifiers: InputModifiers;
}

export interface WheelMessage {
  v: 1;
  type: "input.wheel";
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers: InputModifiers;
}

export interface KeyMessage {
  v: 1;
  type: "input.keyDown" | "input.keyUp";
  key: string;
  code: string;
  repeat: boolean;
  location: number;
  modifiers: InputModifiers;
}

export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function mapContainedPoint(
  clientX: number,
  clientY: number,
  container: DisplayRect,
  frameWidth: number,
  frameHeight: number,
): { x: number; y: number } | undefined {
  if (container.width <= 0 || container.height <= 0 || frameWidth <= 0 || frameHeight <= 0) return;
  const scale = Math.min(container.width / frameWidth, container.height / frameHeight);
  const displayedWidth = frameWidth * scale;
  const displayedHeight = frameHeight * scale;
  const offsetX = container.left + (container.width - displayedWidth) / 2;
  const offsetY = container.top + (container.height - displayedHeight) / 2;
  if (
    clientX < offsetX ||
    clientY < offsetY ||
    clientX >= offsetX + displayedWidth ||
    clientY >= offsetY + displayedHeight
  )
    return;
  return { x: (clientX - offsetX) / scale, y: (clientY - offsetY) / scale };
}

export type ServerStreamMessage =
  | { v: 1; type: "stream.authenticated"; sessionId: SessionId }
  | { v: 1; type: "stream.error"; code: StreamErrorCode; message: string }
  | { v: 1; type: "stream.closed"; reason: string }
  | { v: 1; type: "frame.config"; format: "jpeg"; width: number; height: number; dpr: 1 }
  | { v: 1; type: "page.loadingChanged"; loading: boolean }
  | { v: 1; type: "page.urlChanged"; url: string }
  | { v: 1; type: "page.titleChanged"; title: string }
  | { v: 1; type: "page.crashed" }
  | { v: 1; type: "browser.crashed" }
  | { v: 1; type: "session.closed" }
  | { v: 1; type: "session.pong"; timestamp?: number };

export interface StreamTicketSuccess {
  ok: true;
  sessionId: SessionId;
  ticket: string;
  expiresAt: string;
}
