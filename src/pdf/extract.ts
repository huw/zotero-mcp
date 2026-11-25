import { PDFDocument } from "pdf-lib";

/** What this needs of the Workers AI binding. */
export type MarkdownConverter = {
	toMarkdown(
		files: { name: string; blob: Blob },
		options?: { conversionOptions?: { output?: { format?: "markdown" | "text" }; pdf?: { metadata?: boolean } } },
	): Promise<{ format: string; data?: string; error?: string }>;
};

/** Text longer than this is cut. Zotero's own indexer stops far short of it. */
export const MAX_FULLTEXT_CHARS = 1_000_000;
const CHUNK_PAGES = 40;
const OPTIONS = { conversionOptions: { output: { format: "text" as const }, pdf: { metadata: false } } };

async function convert(ai: MarkdownConverter, name: string, bytes: Uint8Array) {
	const result = await ai.toMarkdown({ name, blob: new Blob([bytes], { type: "application/pdf" }) }, OPTIONS);
	if (result.format === "error") {
		throw new Error(result.error ?? "Workers AI could not convert the PDF.");
	}
	return result.data ?? "";
}

/** Splits a PDF into page ranges, each a small PDF of its own. Reads the whole document, so it is kept for files small enough to hold. */
async function* chunksOf(bytes: Uint8Array) {
	const source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
	const total = source.getPageCount();
	for (let start = 0; start < total; start += CHUNK_PAGES) {
		const part = await PDFDocument.create();
		const pages = await part.copyPages(source, Array.from({ length: Math.min(CHUNK_PAGES, total - start) }, (_, i) => start + i));
		pages.forEach((page) => part.addPage(page));
		yield { bytes: await part.save(), total };
	}
}

/** The number of pages, or undefined if the file cannot be read well enough to count them. */
export async function countPages(bytes: Uint8Array) {
	try {
		return (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
	} catch {
		return undefined;
	}
}

export type Extracted = { text: string; pages: number | undefined; method: "whole" | "chunks" };

/**
 * Turns a PDF into plain text with Workers AI. The whole file goes in first. If that fails (a very long or heavy document, say),
 * it is split into page ranges and converted piece by piece. A PDF that is only page images has no text and comes back empty.
 */
export async function extractText(ai: MarkdownConverter, name: string, bytes: Uint8Array): Promise<Extracted> {
	try {
		const text = (await convert(ai, name, bytes)).trim();
		return { text: text.slice(0, MAX_FULLTEXT_CHARS), pages: await countPages(bytes), method: "whole" };
	} catch (whole) {
		console.error("Whole-file conversion failed, trying page ranges", { error: whole instanceof Error ? whole.message : String(whole) });
	}

	const parts: string[] = [];
	let pages: number | undefined;
	let length = 0;
	for await (const chunk of chunksOf(bytes)) {
		pages = chunk.total;
		const text = (await convert(ai, name, chunk.bytes)).trim();
		parts.push(text);
		length += text.length;
		if (length > MAX_FULLTEXT_CHARS) {
			break;
		}
	}
	return { text: parts.join("\n\n").trim().slice(0, MAX_FULLTEXT_CHARS), pages, method: "chunks" };
}
