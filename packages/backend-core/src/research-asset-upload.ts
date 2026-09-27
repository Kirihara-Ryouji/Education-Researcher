import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

export const RESEARCH_ASSET_MAX_BYTES = 64 * 1024 * 1024;

export class ResearchAssetError extends Error {
  constructor(message: string, readonly status: 400 | 413) {
    super(message);
    this.name = "ResearchAssetError";
  }
}

export interface StagedResearchAsset {
  path: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

const MEDIA_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
};

function safeFilename(raw: string): { filename: string; mediaType: string } {
  const filename = raw.normalize("NFC").trim();
  if (!filename || filename.length > 240 || filename.includes("/") || filename.includes("\\") || filename.includes("\0") || filename === "." || filename === "..") {
    throw new ResearchAssetError("Choose a file with a valid filename", 400);
  }
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const mediaType = MEDIA_TYPES[extension];
  if (!mediaType) throw new ResearchAssetError("Supported file types: PDF, DOCX, TXT, MD, CSV", 400);
  return { filename, mediaType };
}

function checkSignature(mediaType: string, prefix: Uint8Array): void {
  if (mediaType === "application/pdf") {
    if (!new TextDecoder("latin1").decode(prefix).includes("%PDF-")) {
      throw new ResearchAssetError("The selected file is not a PDF", 400);
    }
  } else if (mediaType.includes("wordprocessingml")) {
    if (prefix[0] !== 0x50 || prefix[1] !== 0x4b) {
      throw new ResearchAssetError("The selected file is not a DOCX archive", 400);
    }
  } else if (prefix.includes(0)) {
    throw new ResearchAssetError("Text files cannot contain binary NUL bytes", 400);
  }
}

/** Stage raw bytes locally; no extraction, model call, or external transfer. */
export async function stageResearchAsset(
  dataDir: string,
  rawFilename: string,
  stream: ReadableStream<Uint8Array> | null,
  maxBytes = RESEARCH_ASSET_MAX_BYTES,
): Promise<StagedResearchAsset> {
  const { filename, mediaType } = safeFilename(rawFilename);
  if (!stream) throw new ResearchAssetError("The selected file is empty", 400);
  const incoming = join(dataDir, "research", "assets", "incoming");
  await mkdir(incoming, { recursive: true });
  const path = join(incoming, `${randomUUID()}.upload`);
  const reader = stream.getReader();
  const digest = createHash("sha256");
  const textDecoder = mediaType.startsWith("text/") ? new TextDecoder("utf-8", { fatal: true }) : null;
  const prefix = new Uint8Array(1024);
  let prefixLength = 0;
  let sizeBytes = 0;

  try {
    const file = await open(path, "wx", 0o600);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        sizeBytes += value.byteLength;
        if (sizeBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ResearchAssetError(`The selected file exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB upload limit`, 413);
        }
        if (textDecoder) {
          if (value.includes(0)) throw new ResearchAssetError("Text files cannot contain binary NUL bytes", 400);
          try { textDecoder.decode(value, { stream: true }); }
          catch { throw new ResearchAssetError("Text files must use UTF-8 encoding", 400); }
        }
        digest.update(value);
        if (prefixLength < prefix.length) {
          const take = Math.min(prefix.length - prefixLength, value.byteLength);
          prefix.set(value.subarray(0, take), prefixLength);
          prefixLength += take;
        }
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
          if (bytesWritten === 0) throw new Error("Could not write uploaded research file");
          offset += bytesWritten;
        }
      }
      if (textDecoder) {
        try { textDecoder.decode(); }
        catch { throw new ResearchAssetError("Text files must use UTF-8 encoding", 400); }
      }
    } finally {
      await file.close();
    }
    if (sizeBytes === 0) throw new ResearchAssetError("The selected file is empty", 400);
    checkSignature(mediaType, prefix.subarray(0, prefixLength));
    return { path, filename, mediaType, sizeBytes, sha256: digest.digest("hex") };
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
