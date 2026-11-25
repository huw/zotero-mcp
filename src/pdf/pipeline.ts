import type { ZoteroItem, ZoteroWriter } from "../zotero";
import { parseJson, ZoteroError } from "../zotero";
import { EXTRACT_MAX_BYTES, hashPdf, openSource, PdfError, readPdf, STORE_MAX_BYTES, TooLargeError } from "./download";
import { extractText, type MarkdownConverter } from "./extract";
import { findPdfCandidates, type PdfCandidate } from "./find";
import { findOrphan, framedStream, hasStoredPdf, storePdf } from "./store";
import { yearOf } from "../document";

export type PipelineDeps = {
	zotero: ZoteroWriter;
	ai: MarkdownConverter;
	unpaywallEmail?: string;
	/** For fetching PDFs and looking them up. Replaceable so tests need no network. */
	fetchFn?: typeof fetch;
};

/** What the first step decides, kept small because a workflow step may return at most 1 MiB. */
export type Plan = {
	parentKey: string;
	skip?: string;
	title?: string;
	filename?: string;
	candidates: PdfCandidate[];
	orphanKey?: string;
};

export type Stored = {
	attachmentKey: string;
	filename: string;
	size: number;
	source: string;
	license?: string | null;
	mode: "extract" | "store-only";
	upload: "uploaded" | "exists";
};

export type Extraction = { extracted: boolean; note: string; pages?: number; characters?: number };

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

function fileNameFor(item: ZoteroItem) {
	const stem = [item.meta?.creatorSummary, yearOf(item), item.data.title].filter(Boolean).join(" - ") || item.key;
	return `${stem.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)}.pdf`;
}

/** Step one: is this an item that needs a PDF, and where could one come from? */
export async function locate(deps: PipelineDeps, itemKey: string): Promise<Plan> {
	const { zotero } = deps;
	const item = parseJson<ZoteroItem>(await zotero.get(`/items/${itemKey}`, { format: "json" }));
	const none = (skip: string): Plan => ({ parentKey: itemKey, skip, candidates: [], title: item.data.title });

	if (item.data.deleted) {
		return none("The item is in the trash.");
	}
	if (["attachment", "note", "annotation"].includes(item.data.itemType)) {
		return none(`That is ${item.data.itemType === "note" ? "a note" : `an ${item.data.itemType}`}, not a paper. Pass the paper's own key.`);
	}
	const children = parseJson<ZoteroItem[]>(await zotero.get(`/items/${itemKey}/children`, { format: "json", limit: 100 }));
	if (hasStoredPdf(children)) {
		return none("It already has a PDF stored in Zotero.");
	}
	if (!item.data.DOI) {
		return none("It has no DOI, so there is nothing to look up an open-access copy by.");
	}
	const candidates = await findPdfCandidates(item.data.DOI, { unpaywallEmail: deps.unpaywallEmail, fetchFn: deps.fetchFn });
	if (candidates.length === 0) {
		return none("No open-access PDF is listed for this DOI. Zotero Desktop's Find Available PDF may reach it through your institution's access.");
	}
	return { parentKey: itemKey, title: item.data.title, filename: fileNameFor(item), candidates, orphanKey: findOrphan(children)?.key };
}

/**
 * Step two: fetch the PDF and store it in Zotero. Under 20 MB it is read into memory once. A larger one (up to 100 MB) is
 * streamed twice, once to hash it and once to upload it, so it never sits in memory whole. Candidates are tried in order, and a
 * paywall page or a dead link moves on to the next.
 */
export async function store(deps: PipelineDeps, plan: Plan): Promise<Stored> {
	const fetchFn = deps.fetchFn ?? fetch;
	const filename = plan.filename ?? `${plan.parentKey}.pdf`;
	const failures: string[] = [];

	for (const candidate of plan.candidates) {
		try {
			const response = await openSource(candidate.url, fetchFn);
			const declared = Number(response.headers.get("Content-Length"));
			let source: Parameters<typeof storePdf>[2]["source"];
			let mode: Stored["mode"] = "extract";
			let size: number;

			if (declared > EXTRACT_MAX_BYTES) {
				mode = "store-only";
				({ source, size } = await streamedSource(candidate.url, response, fetchFn));
			} else {
				try {
					const pdf = await readPdf(response, EXTRACT_MAX_BYTES);
					size = pdf.size;
					source = { size: pdf.size, md5: pdf.md5, body: async (prefix, suffix) => new Blob([prefix, pdf.bytes, suffix]) };
				} catch (error) {
					// No Content-Length, and it turned out to be bigger than memory allows: take the streaming path.
					if (!(error instanceof TooLargeError)) {
						throw error;
					}
					mode = "store-only";
					({ source, size } = await streamedSource(candidate.url, await openSource(candidate.url, fetchFn), fetchFn));
				}
			}

			const { attachmentKey, result } = await storePdf(deps.zotero, plan.parentKey, { filename, sourceUrl: candidate.url, source, orphanKey: plan.orphanKey }, fetchFn);
			return { attachmentKey, filename, size, source: candidate.url, license: candidate.license, mode, upload: result };
		} catch (error) {
			// A problem with this one address moves on to the next. A problem with Zotero itself (quota, key, locked library) stops everything.
			if (error instanceof ZoteroError || !(error instanceof PdfError || error instanceof TypeError)) {
				throw error;
			}
			failures.push(`${new URL(candidate.url).hostname}: ${error.message}`);
		}
	}
	throw new Error(`None of the open-access links gave a usable PDF. ${failures.join(" ")}`);
}

/** Hashes the PDF in a first pass, and supplies a second fetch of it as the upload body. */
async function streamedSource(url: string, first: Response, fetchFn: typeof fetch) {
	const { size, md5 } = await hashPdf(first, STORE_MAX_BYTES);
	return {
		size,
		source: {
			size,
			md5,
			async body(prefix: Uint8Array, suffix: Uint8Array) {
				const again = await openSource(url, fetchFn);
				const length = Number(again.headers.get("Content-Length"));
				if (Number.isFinite(length) && length > 0 && length !== size) {
					throw new PdfError("The PDF changed between the two fetches.");
				}
				return framedStream(prefix, again.body as ReadableStream<Uint8Array>, size, suffix);
			},
		},
	};
}

/**
 * Step three: read the text out of the PDF Zotero now holds and hand it back to Zotero as the attachment's full text, so
 * get_fulltext, keyword search and the semantic index all see it. Larger PDFs are left for Zotero Desktop to index.
 */
export async function extract(deps: PipelineDeps, stored: Stored): Promise<Extraction> {
	if (stored.mode === "store-only") {
		return { extracted: false, note: `Stored (${mb(stored.size)}) without extracting text: files over ${mb(EXTRACT_MAX_BYTES)} are left for Zotero Desktop to index when it syncs.` };
	}
	const fetchFn = deps.fetchFn ?? fetch;
	// The file is read back from Zotero rather than kept from the last step, since steps do not share memory.
	const location = await deps.zotero.fileLocation(stored.attachmentKey);
	const response = await fetchFn(location);
	if (!response.ok) {
		throw new Error(`Could not read the stored PDF back (HTTP ${response.status}).`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());

	const { text, pages, method } = await extractText(deps.ai, stored.filename, bytes);
	if (!text) {
		return { extracted: false, note: "The PDF has no text layer (it is probably scanned pages), so there was no text to extract. Zotero Desktop's OCR can add it.", pages };
	}
	const counts = pages !== undefined ? { indexedPages: pages, totalPages: pages } : { indexedChars: text.length, totalChars: text.length };
	await deps.zotero.send("PUT", `/items/${stored.attachmentKey}/fulltext`, { content: text, ...counts });
	return { extracted: true, note: `Text extracted${method === "chunks" ? " in page ranges" : ""} and saved as the attachment's full text.`, pages, characters: text.length };
}
