import { FRAME_HEADER_BYTES, STREAM_PROTOCOL_VERSION } from "@remote-browser/protocol";

const MAGIC = "RBV1";
export const JPEG_FORMAT_CODE = 1;

export interface FrameHeader {
  sequence: number;
  width: number;
  height: number;
  format: "jpeg";
}

export function encodeFrame(header: FrameHeader, jpeg: Buffer): Buffer {
  const output = Buffer.allocUnsafe(FRAME_HEADER_BYTES + jpeg.length);
  output.write(MAGIC, 0, "ascii");
  output.writeUInt8(STREAM_PROTOCOL_VERSION, 4);
  output.writeUInt8(JPEG_FORMAT_CODE, 5);
  output.writeUInt16BE(FRAME_HEADER_BYTES, 6);
  output.writeUInt32BE(header.sequence, 8);
  output.writeUInt32BE(header.width, 12);
  output.writeUInt32BE(header.height, 16);
  jpeg.copy(output, FRAME_HEADER_BYTES);
  return output;
}

export function decodeFrame(packet: Uint8Array): FrameHeader & { jpeg: Uint8Array } {
  const view = Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
  if (view.length < FRAME_HEADER_BYTES || view.toString("ascii", 0, 4) !== MAGIC) {
    throw new Error("Invalid remote viewport frame header");
  }
  if (view.readUInt8(4) !== STREAM_PROTOCOL_VERSION) throw new Error("Frame protocol mismatch");
  if (view.readUInt8(5) !== JPEG_FORMAT_CODE) throw new Error("Unsupported frame format");
  if (view.readUInt16BE(6) !== FRAME_HEADER_BYTES) throw new Error("Invalid frame header length");
  return {
    sequence: view.readUInt32BE(8),
    width: view.readUInt32BE(12),
    height: view.readUInt32BE(16),
    format: "jpeg",
    jpeg: view.subarray(FRAME_HEADER_BYTES),
  };
}
