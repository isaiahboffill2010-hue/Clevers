import { encodeFrame } from "./frame-protocol.js";

export interface RawFrame {
  sequence: number;
  width: number;
  height: number;
  jpeg: Buffer;
}

export interface FrameTransportStats {
  framesReceived: number;
  framesSent: number;
  framesDropped: number;
  bytesSent: number;
  queueDepth: number;
}

export class LatestFrameTransport {
  readonly #send: (packet: Buffer) => Promise<void>;
  readonly #stats: FrameTransportStats = {
    framesReceived: 0,
    framesSent: 0,
    framesDropped: 0,
    bytesSent: 0,
    queueDepth: 0,
  };
  #sending = false;
  #pending: RawFrame | undefined;
  #closed = false;

  constructor(send: (packet: Buffer) => Promise<void>) {
    this.#send = send;
  }

  enqueue(frame: RawFrame): void {
    if (this.#closed) return;
    this.#stats.framesReceived += 1;
    if (this.#sending) {
      if (this.#pending) this.#stats.framesDropped += 1;
      this.#pending = frame;
      this.#stats.queueDepth = 1;
      return;
    }
    this.#dispatch(frame);
  }

  snapshot(): Readonly<FrameTransportStats> {
    return { ...this.#stats };
  }

  close(): void {
    this.#closed = true;
    this.#pending = undefined;
    this.#stats.queueDepth = 0;
  }

  #dispatch(frame: RawFrame): void {
    this.#sending = true;
    const packet = encodeFrame({ ...frame, format: "jpeg" }, frame.jpeg);
    void this.#send(packet)
      .then(() => {
        this.#stats.framesSent += 1;
        this.#stats.bytesSent += packet.length;
      })
      .catch(() => undefined)
      .finally(() => {
        this.#sending = false;
        const next = this.#pending;
        this.#pending = undefined;
        this.#stats.queueDepth = 0;
        if (next && !this.#closed) this.#dispatch(next);
      });
  }
}
