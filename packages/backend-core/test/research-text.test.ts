import { describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import JSZip from "jszip";
import type { ResearchAsset } from "@brainpilot/protocol";
import { countResearchPdfPages, extractResearchText, selectResearchQuote } from "../src/research-text-extraction.js";
import { samplePdf } from "./research-pdf-fixture.js";

function asset(mediaType: string, bytes: Buffer): ResearchAsset {
  return {
    id: randomUUID(), sourceId: randomUUID(), version: 1,
    filename: "test", mediaType, sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    accessNote: "Test fixture", createdAt: new Date().toISOString(),
  };
}

async function sampleDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>First paragraph</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("research file text extraction", () => {
  it("keeps physical line numbers for UTF-8 text, including blank lines", async () => {
    const bytes = Buffer.from("Alpha\r\n\r\nBeta");
    const view = await extractResearchText(asset("text/plain", bytes), bytes, 1);
    expect(view.sectionKind).toBe("lines");
    expect(view.segments.map(({ locator, text }) => [locator, text])).toEqual([
      ["text:l1", "Alpha"], ["text:l3", "Beta"],
    ]);
    await expect(extractResearchText(asset("text/plain", bytes), bytes, 2)).rejects.toMatchObject({ status: 400 });
  });

  it("paginates text without resetting original line numbers", async () => {
    const bytes = Buffer.from(Array.from({ length: 105 }, (_, index) => `Line ${index + 1}`).join("\n"));
    const view = await extractResearchText(asset("text/markdown", bytes), bytes, 2);
    expect(view.sectionCount).toBe(2);
    expect(view.segments[0]).toMatchObject({ locator: "text:l101", text: "Line 101" });
  });

  it("extracts a passage with a real PDF page number", async () => {
    const bytes = samplePdf();
    const view = await extractResearchText(asset("application/pdf", bytes), bytes, 1);
    expect(view.sectionKind).toBe("page");
    expect(view.sectionCount).toBe(1);
    expect(view.segments.some((segment) => segment.locator.startsWith("pdf:p1:") && segment.text.includes("Hello from PDF"))).toBe(true);
  });

  it("uses an exact selected range and rejects an invalid or split-character range", () => {
    const segment = { index: 0, locator: "text:l1", text: "Alpha Beta 😀" };
    expect(selectResearchQuote(segment, 6, 10)).toEqual({ locator: "text:l1:u166-10", content: "Beta" });
    expect(selectResearchQuote(segment, 5, 11)).toEqual({ locator: "text:l1:u166-10", content: "Beta" });
    expect(() => selectResearchQuote(segment, 6, 100)).toThrow();
    expect(() => selectResearchQuote(segment, 11, 12)).toThrow();
  });

  it("counts a PDF page even when it has no selectable text", async () => {
    const bytes = samplePdf("");
    expect(await countResearchPdfPages(bytes)).toBe(1);
    const view = await extractResearchText(asset("application/pdf", bytes), bytes, 1);
    expect(view.segments).toHaveLength(0);
    expect(view.warnings).toContain("NO_SELECTABLE_TEXT");
  });

  it("extracts ordered DOCX paragraphs", async () => {
    const bytes = await sampleDocx();
    const view = await extractResearchText(asset("application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes), bytes, 1);
    expect(view.sectionKind).toBe("paragraphs");
    expect(view.segments.map(({ locator, text }) => [locator, text])).toEqual([
      ["docx:p1", "First paragraph"], ["docx:p2", "Second paragraph"],
    ]);
  });

  it("rejects invalid UTF-8 rather than inventing a quote", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0xff]);
    await expect(extractResearchText(asset("text/plain", bytes), bytes, 1)).rejects.toMatchObject({ status: 422 });
  });
});
