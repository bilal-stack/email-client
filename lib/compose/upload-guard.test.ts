// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateAttachments } from "./upload-guard";

function makeFile(name: string, contents: Uint8Array, type = "application/octet-stream"): File {
  // `File` BlobPart requires Uint8Array<ArrayBuffer>; node's typings widen to
  // ArrayBufferLike via SharedArrayBuffer. Cast at the boundary — the bytes
  // themselves are fine, only the generic on the underlying ArrayBuffer differs.
  return new File([contents as unknown as BlobPart], name, { type });
}

function bytesOfSize(n: number): Uint8Array {
  // Use a small repeating pattern; we never inspect the content beyond length.
  return new Uint8Array(n);
}

describe("validateAttachments", () => {
  it("returns an empty list when no files are supplied", async () => {
    const result = await validateAttachments([]);
    expect(result).toEqual({ ok: true, attachments: [] });
  });

  it("accepts a single 1 MB plain text file and exposes bytes as a Buffer", async () => {
    const oneMb = 1 * 1024 * 1024;
    const file = makeFile("notes.txt", bytesOfSize(oneMb), "text/plain");

    const result = await validateAttachments([file]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.attachments).toHaveLength(1);
    const attachment = result.attachments[0];
    if (!attachment) throw new Error("expected one attachment");
    expect(attachment.filename).toBe("notes.txt");
    expect(attachment.mimeType).toBe("text/plain");
    expect(Buffer.isBuffer(attachment.content)).toBe(true);
    expect(attachment.content.length).toBe(1_048_576);
  });

  it("rejects when total size across multiple files exceeds 25 MB", async () => {
    // Three 10 MB files = 30 MB total > 25 MB cap.
    const tenMb = 10 * 1024 * 1024;
    const files = [
      makeFile("a.bin", bytesOfSize(tenMb), "application/octet-stream"),
      makeFile("b.bin", bytesOfSize(tenMb), "application/octet-stream"),
      makeFile("c.bin", bytesOfSize(tenMb), "application/octet-stream"),
    ];

    const result = await validateAttachments(files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/25 MB/);
  });

  it("rejects more than 20 files", async () => {
    const files = Array.from({ length: 21 }, (_, i) =>
      makeFile(`f${i}.txt`, bytesOfSize(10), "text/plain"),
    );

    const result = await validateAttachments(files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Too many/);
  });

  it("rejects a file whose MIME type is on the deny list", async () => {
    const file = makeFile("evil.exe", bytesOfSize(10), "application/x-msdownload");

    const result = await validateAttachments([file]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/blocked file type/);
  });

  it("rejects a denied extension even when MIME is innocent (.exe + application/octet-stream)", async () => {
    const file = makeFile("evil.exe", bytesOfSize(10), "application/octet-stream");

    const result = await validateAttachments([file]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/blocked extension/);
  });

  it("returns early on the first denied file and does not return a partial attachment list", async () => {
    const oneKb = 1024;
    const good1 = makeFile("a.txt", bytesOfSize(oneKb), "text/plain");
    const good2 = makeFile("b.txt", bytesOfSize(oneKb), "text/plain");
    const good3 = makeFile("c.txt", bytesOfSize(oneKb), "text/plain");
    const denied = makeFile("d.exe", bytesOfSize(oneKb), "application/x-msdownload");

    const result = await validateAttachments([good1, good2, good3, denied]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The contract is "return on first denial" — the result has no `attachments` field.
    expect((result as { attachments?: unknown }).attachments).toBeUndefined();
  });

  it("accepts a file with an empty MIME and stores it as application/octet-stream", async () => {
    const file = makeFile("anonymous.bin", bytesOfSize(10), "");

    const result = await validateAttachments([file]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const attachment = result.attachments[0];
    if (!attachment) throw new Error("expected one attachment");
    expect(attachment.mimeType).toBe("application/octet-stream");
  });
});
