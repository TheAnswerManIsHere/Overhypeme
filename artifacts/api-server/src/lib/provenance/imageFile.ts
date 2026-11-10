/**
 * @purpose An image file's true format, read from its bytes, and the provenance stamp written into its container without touching its pixels: one XMP packet carrying the opaque provenance id (and, for an AI render, the engine name) — never settings or prompts (plan PLAN_IMAGE_TRACING.md, Never). PNG gets an iTXt chunk, JPEG an APP1 segment, WebP an XMP chunk; a format we cannot stamp is returned unchanged and still recorded.
 *
 * Splicing the container instead of re-encoding is what keeps "comparison
 * pictures keep their pixels exactly" and "the watermark never re-draws or
 * re-compresses" true: the decoded image is byte-identical before and after.
 */
import { crc32 } from "node:zlib";

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "unknown";

export interface SniffedImage {
  format: ImageFormat;
  mime: string;
  ext: string;
}

const MIME: Record<ImageFormat, { mime: string; ext: string }> = {
  png: { mime: "image/png", ext: "png" },
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  webp: { mime: "image/webp", ext: "webp" },
  gif: { mime: "image/gif", ext: "gif" },
  unknown: { mime: "application/octet-stream", ext: "bin" },
};

/** The format the bytes actually are, whatever a vendor or a file name claims. */
export function sniffImage(buf: Buffer): SniffedImage {
  let format: ImageFormat = "unknown";
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) format = "png";
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) format = "jpeg";
  else if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") format = "webp";
  else if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) format = "gif";
  return { format, ...MIME[format] };
}

export interface ProvenanceStamp {
  /** The provenance record's opaque id. */
  id: number;
  /** The engine's name, for an AI render only; never for a comparison picture. */
  engine?: string | null;
}

const XMP_NS = "https://overhype.me/ns/provenance/1.0/";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The XMP packet: the id, and the engine name when given. Nothing else. */
export function xmpPacket(stamp: ProvenanceStamp): string {
  const engine = stamp.engine ? ` ovh:Engine="${xmlEscape(stamp.engine)}"` : "";
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:ovh="${XMP_NS}" ovh:ProvenanceId="${stamp.id}"${engine}/>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="r"?>`
  );
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function stampPng(buf: Buffer, xmp: string): Buffer {
  // iTXt: keyword, null, compression flag 0, method 0, empty language tag,
  // null, empty translated keyword, null, then UTF-8 text.
  const data = Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.from(xmp, "utf8")]);
  // Insert straight after IHDR (8-byte signature + 25-byte IHDR chunk).
  const ihdrEnd = 8 + 8 + buf.readUInt32BE(8) + 4;
  return Buffer.concat([buf.subarray(0, ihdrEnd), pngChunk("iTXt", data), buf.subarray(ihdrEnd)]);
}

function stampJpeg(buf: Buffer, xmp: string): Buffer {
  const payload = Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(xmp, "utf8")]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(payload.length + 2, 2);
  // After SOI, and after a JFIF APP0 when one leads, as readers expect.
  let at = 2;
  if (buf[2] === 0xff && buf[3] === 0xe0) at = 4 + buf.readUInt16BE(4);
  return Buffer.concat([buf.subarray(0, at), seg, payload, buf.subarray(at)]);
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, "ascii");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** Canvas size of a simple-format WebP, from its VP8 or VP8L bitstream header. */
function webpCanvas(buf: Buffer): { w: number; h: number } | null {
  const fourcc = buf.toString("ascii", 12, 16);
  if (fourcc === "VP8 ") {
    // Frame header: 3-byte tag, 3-byte start code, then 14-bit width/height.
    const o = 20 + 6;
    return { w: buf.readUInt16LE(o) & 0x3fff, h: buf.readUInt16LE(o + 2) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function stampWebp(buf: Buffer, xmp: string): Buffer | null {
  const xmpChunk = riffChunk("XMP ", Buffer.from(xmp, "utf8"));
  const first = buf.toString("ascii", 12, 16);
  let body: Buffer;
  if (first === "VP8X") {
    body = Buffer.from(buf.subarray(12));
    body[8] = body[8]! | 0x04; // XMP flag
    body = Buffer.concat([body, xmpChunk]);
  } else {
    const size = webpCanvas(buf);
    if (!size) return null;
    const vp8x = Buffer.alloc(10);
    // XMP flag; the alpha flag only when a lossless bitstream says it uses alpha.
    const losslessAlpha = first === "VP8L" && ((buf.readUInt32LE(21) >>> 28) & 1) === 1;
    vp8x[0] = 0x04 | (losslessAlpha ? 0x10 : 0);
    vp8x.writeUIntLE(size.w - 1, 4, 3);
    vp8x.writeUIntLE(size.h - 1, 7, 3);
    body = Buffer.concat([riffChunk("VP8X", vp8x), buf.subarray(12), xmpChunk]);
  }
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "ascii");
  return Buffer.concat([head, body]);
}

/**
 * The bytes with the provenance stamp spliced into their container. Returns
 * null for a format we cannot stamp (GIF, unknown); the caller still records
 * the picture, unstamped.
 */
export function stampImage(buf: Buffer, stamp: ProvenanceStamp): Buffer | null {
  const xmp = xmpPacket(stamp);
  const { format } = sniffImage(buf);
  if (format === "png") return stampPng(buf, xmp);
  if (format === "jpeg") return stampJpeg(buf, xmp);
  if (format === "webp") return stampWebp(buf, xmp);
  return null;
}

/** The provenance id stamped into a file's metadata, if it still carries one. */
export function readStampedId(buf: Buffer): number | null {
  const text = buf.toString("latin1");
  const m = /ovh:ProvenanceId="(\d{1,16})"/.exec(text);
  if (!m || !text.includes(XMP_NS)) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : null;
}
