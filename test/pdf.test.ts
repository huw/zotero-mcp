import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { checkSourceUrl, EXTRACT_MAX_BYTES, hashPdf, looksLikePdf, openSource, PdfError, readPdf, TooLargeError } from "../src/pdf/download";
import { extractText, type MarkdownConverter } from "../src/pdf/extract";
import { findPdfCandidates } from "../src/pdf/find";
import { extract, locate, type PipelineDeps, store } from "../src/pdf/pipeline";
import { ATTACHMENT_TITLE, findOrphan, framedStream, hasStoredPdf, storePdf, uploadAttachmentFile } from "../src/pdf/store";
import { type Params, ZoteroError, type ZoteroResponse, type ZoteroWriter } from "../src/zotero";
import { item } from "./fakes";

const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const pdfBytes = async (pages = 1) => {
	const doc = await PDFDocument.create();
	for (let i = 0; i < pages; i++) doc.addPage();
	return doc.save();
};
const reply = (body: unknown, extra: Partial<ZoteroResponse> = {}): ZoteroResponse => ({ status: 200, version: 1, total: undefined, body: JSON.stringify(body), ...extra });

/** A fetch that answers from a table of address to response. */
function web(routes: Record<string, () => Response | Promise<Response>>) {
	const seen: string[] = [];
	const fetchFn = (async (input: RequestInfo | URL) => {
		const url = String(input);
		seen.push(url);
		const route = routes[url];
		return route ? route() : new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetchFn, seen };
}

describe("checkSourceUrl", () => {
	it("accepts https addresses on public host names", () => {
		expect(checkSourceUrl("https://europepmc.org/articles/PMC1/pdf/x.pdf").hostname).toBe("europepmc.org");
	});

	it("refuses everything that could reach something it should not", () => {
		for (const bad of [
			"http://example.org/a.pdf", "https://127.0.0.1/a.pdf", "https://10.0.0.5/a.pdf", "https://169.254.169.254/latest", "https://[::1]/a.pdf",
			"https://localhost/a.pdf", "https://printer.local/a.pdf", "https://db.internal/a.pdf", "https://intranet/a.pdf", "https://example.org:8443/a.pdf",
			"https://user:pass@example.org/a.pdf", "ftp://example.org/a.pdf", "not a url", "file:///etc/passwd",
		]) {
			expect(() => checkSourceUrl(bad), bad).toThrow(PdfError);
		}
	});
});

describe("openSource", () => {
	const pdf = () => new Response("%PDF-1.4 x", { headers: { "Content-Length": "10" } });

	it("follows redirects, checking every hop", async () => {
		const { fetchFn, seen } = web({
			"https://a.example.org/x": () => new Response(null, { status: 302, headers: { Location: "https://cdn.example.org/y.pdf" } }),
			"https://cdn.example.org/y.pdf": pdf,
		});
		const response = await openSource("https://a.example.org/x", fetchFn);
		expect(await response.text()).toBe("%PDF-1.4 x");
		expect(seen).toEqual(["https://a.example.org/x", "https://cdn.example.org/y.pdf"]);
	});

	it("refuses a redirect to somewhere it must not go", async () => {
		const { fetchFn, seen } = web({ "https://a.example.org/x": () => new Response(null, { status: 302, headers: { Location: "https://169.254.169.254/latest/meta-data" } }) });
		await expect(openSource("https://a.example.org/x", fetchFn)).rejects.toThrow(PdfError);
		expect(seen).toHaveLength(1);
	});

	it("refuses error pages, redirect loops, and a file declared bigger than the limit", async () => {
		const loop = web({ "https://a.example.org/x": () => new Response(null, { status: 302, headers: { Location: "https://a.example.org/x" } }) });
		await expect(openSource("https://a.example.org/x", loop.fetchFn)).rejects.toThrow("Too many redirects");
		await expect(openSource("https://a.example.org/missing", web({}).fetchFn)).rejects.toThrow("HTTP 404");
		const huge = web({ "https://a.example.org/big": () => new Response("x", { headers: { "Content-Length": String(101 * 1024 * 1024) } }) });
		await expect(openSource("https://a.example.org/big", huge.fetchFn)).rejects.toBeInstanceOf(TooLargeError);
	});
});

describe("reading and hashing", () => {
	it("recognises a PDF, and not a login page", () => {
		expect(looksLikePdf(new TextEncoder().encode("%PDF-1.7\n..."))).toBe(true);
		expect(looksLikePdf(new TextEncoder().encode("junk\n%PDF-1.4"))).toBe(true);
		expect(looksLikePdf(new TextEncoder().encode("<html><title>Sign in</title>"))).toBe(false);
	});

	it("readPdf and hashPdf agree with each other and with a reference MD5", async () => {
		const bytes = await pdfBytes(3);
		const read = await readPdf(new Response(bytes));
		const hashed = await hashPdf(new Response(bytes));
		expect(read.md5).toBe(md5(bytes));
		expect(hashed).toEqual({ size: bytes.byteLength, md5: md5(bytes) });
		expect(read.size).toBe(bytes.byteLength);
	});

	it("rejects a page that is not a PDF, and a body over the cap", async () => {
		await expect(readPdf(new Response("<html>paywall</html>"))).rejects.toThrow("did not return a PDF");
		await expect(hashPdf(new Response("<html>paywall</html>"))).rejects.toThrow("did not return a PDF");
		const bytes = await pdfBytes();
		await expect(readPdf(new Response(bytes), 50)).rejects.toBeInstanceOf(TooLargeError);
		await expect(hashPdf(new Response(bytes), 50)).rejects.toBeInstanceOf(TooLargeError);
	});
});

describe("findPdfCandidates", () => {
	const openAlex = {
		best_oa_location: { pdf_url: "https://a.example.org/best.pdf", license: "cc-by" },
		locations: [
			{ is_oa: true, pdf_url: "https://a.example.org/best.pdf" },
			{ is_oa: true, pdf_url: "https://b.example.org/repo.pdf", license: "cc-by-nc" },
			{ is_oa: false, pdf_url: "https://paywall.example.org/x.pdf" },
			{ is_oa: true, pdf_url: null },
		],
	};
	const oa = "https://api.openalex.org/works/doi:10.1/x?select=best_oa_location,locations";
	const up = "https://api.unpaywall.org/v2/10.1/x?email=me%40example.org";

	it("lists open-access PDFs from OpenAlex, best first, without duplicates or closed copies", async () => {
		const { fetchFn, seen } = web({ [oa]: () => Response.json(openAlex) });
		const found = await findPdfCandidates("10.1/x", { fetchFn });
		expect(found.map((c) => c.url)).toEqual(["https://a.example.org/best.pdf", "https://b.example.org/repo.pdf"]);
		expect(found[0]).toMatchObject({ source: "openalex", license: "cc-by" });
		expect(seen).toEqual([oa]);
	});

	it("asks Unpaywall only when an email is configured, and survives either service failing", async () => {
		const { fetchFn, seen } = web({
			[oa]: () => new Response("down", { status: 500 }),
			[up]: () => Response.json({ best_oa_location: { url_for_pdf: "https://u.example.org/p.pdf", license: "cc0" }, oa_locations: [{ url_for_pdf: null }] }),
		});
		const found = await findPdfCandidates("10.1/x", { fetchFn, unpaywallEmail: "me@example.org" });
		expect(found).toEqual([{ url: "https://u.example.org/p.pdf", source: "unpaywall", license: "cc0" }]);
		expect(seen).toContain(up);
		const without = web({ [oa]: () => Response.json({}) });
		expect(await findPdfCandidates("10.1/x", { fetchFn: without.fetchFn })).toEqual([]);
		expect(without.seen.some((u) => u.includes("unpaywall"))).toBe(false);
	});

	it("treats an unknown DOI as no candidates", async () => {
		expect(await findPdfCandidates("10.1/x", { fetchFn: web({}).fetchFn })).toEqual([]);
	});
});

describe("framedStream", () => {
	it("is the prefix, the bytes and the suffix, with a length known in advance", async () => {
		const body = new Uint8Array(70000).map((_, i) => i % 251);
		const out = new Uint8Array(await new Response(framedStream(new TextEncoder().encode("PRE"), new Response(body).body as ReadableStream<Uint8Array>, body.byteLength, new TextEncoder().encode("SUF"))).arrayBuffer());
		expect(out.byteLength).toBe(70006);
		expect(new TextDecoder().decode(out.subarray(0, 3))).toBe("PRE");
		expect(md5(out.subarray(3, 70003))).toBe(md5(body));
		expect(new TextDecoder().decode(out.subarray(70003))).toBe("SUF");
	});
});

function writer(overrides: Partial<ZoteroWriter> & { forms?: unknown[]; sent?: unknown[]; library?: Record<string, ZoteroResponse> } = {}) {
	const forms: { path: string; fields: Record<string, string>; headers?: Record<string, string> }[] = [];
	const sent: { method: string; path: string; body: unknown; headers?: Record<string, string> }[] = [];
	const zotero: ZoteroWriter = {
		hasBudget: () => true,
		async get(path: string, _params?: Params) {
			const hit = overrides.library?.[path];
			if (!hit) throw new Error(`unhandled get ${path}`);
			return hit;
		},
		async send(method, path, body, headers) {
			sent.push({ method, path, body, headers });
			if (method === "POST" && path === "/items") return reply({ success: { "0": "NEWATTCH" }, successful: {}, unchanged: {}, failed: {} });
			return { status: 204, version: 2, total: undefined, body: "" };
		},
		async sendForm(path, fields, headers) {
			forms.push({ path, fields, headers });
			if (fields.upload) return { status: 204, version: 3, total: undefined, body: "" };
			return reply({ url: "https://s3.example.org/upload", contentType: "multipart/form-data; boundary=x", prefix: "--x\r\nHEAD\r\n", suffix: "\r\n--x--", uploadKey: "UPKEY" });
		},
		async fileLocation() {
			return "https://files.example.org/stored.pdf";
		},
		async itemTemplate() {
			return {};
		},
		...overrides,
	};
	return { zotero, forms, sent };
}

describe("uploadAttachmentFile", () => {
	const source = (bytes: Uint8Array) => ({ size: bytes.byteLength, md5: md5(bytes), body: async (prefix: Uint8Array, suffix: Uint8Array) => new Blob([prefix, bytes, suffix]) });

	it("authorises, uploads the bytes between Zotero's prefix and suffix, and confirms", async () => {
		const bytes = await pdfBytes();
		const { zotero, forms } = writer();
		const uploads: { url: string; type: string | null; body: Uint8Array }[] = [];
		const send = (async (url: string, init: RequestInit) => {
			uploads.push({ url, type: new Headers(init.headers).get("Content-Type"), body: new Uint8Array(await new Response(init.body).arrayBuffer()) });
			return new Response(null, { status: 201 });
		}) as unknown as typeof fetch;

		expect(await uploadAttachmentFile(zotero, "ATTACHME", "paper.pdf", source(bytes), send)).toBe("uploaded");

		expect(forms[0]).toMatchObject({ path: "/items/ATTACHME/file", headers: { "If-None-Match": "*" }, fields: { md5: md5(bytes), filename: "paper.pdf", filesize: String(bytes.byteLength) } });
		expect(Number(forms[0]?.fields.mtime)).toBeGreaterThan(1.7e12); // milliseconds, as Zotero requires
		expect(uploads[0]).toMatchObject({ url: "https://s3.example.org/upload", type: "multipart/form-data; boundary=x" });
		expect(new TextDecoder().decode(uploads[0]?.body.subarray(0, 11))).toBe("--x\r\nHEAD\r\n");
		expect(forms[1]).toMatchObject({ fields: { upload: "UPKEY" }, headers: { "If-None-Match": "*" } });
	});

	it("does nothing more when Zotero already holds the same file", async () => {
		const forms: { path: string; fields: Record<string, string>; headers?: Record<string, string> }[] = [];
		const { zotero } = writer({ sendForm: async (path, fields, headers) => (void forms.push({ path, fields, headers }), reply({ exists: 1 })) });
		const send = (async () => { throw new Error("should not upload"); }) as unknown as typeof fetch;
		expect(await uploadAttachmentFile(zotero, "ATTACHME", "p.pdf", source(await pdfBytes()), send)).toBe("exists");
		expect(forms).toHaveLength(1);
	});

	it("reports a refused upload, and does not confirm it", async () => {
		const { zotero, forms } = writer();
		const send = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
		await expect(uploadAttachmentFile(zotero, "ATTACHME", "p.pdf", source(await pdfBytes()), send)).rejects.toThrow("HTTP 403");
		expect(forms).toHaveLength(1);
	});
});

describe("storePdf", () => {
	const src = async () => {
		const bytes = await pdfBytes();
		return { size: bytes.byteLength, md5: md5(bytes), body: async (p: Uint8Array, s: Uint8Array) => new Blob([p, bytes, s]) };
	};
	const ok = (async () => new Response(null, { status: 201 })) as unknown as typeof fetch;

	it("creates a child attachment for the PDF, then uploads to it", async () => {
		const { zotero, sent, forms } = writer();
		const result = await storePdf(zotero, "PARENTPA", { filename: "a.pdf", sourceUrl: "https://x.example.org/a.pdf", source: await src() }, ok);
		expect(result).toEqual({ attachmentKey: "NEWATTCH", result: "uploaded" });
		expect(sent[0]).toMatchObject({ method: "POST", path: "/items" });
		expect((sent[0]?.body as Record<string, unknown>[])[0]).toMatchObject({ itemType: "attachment", parentItem: "PARENTPA", linkMode: "imported_url", title: ATTACHMENT_TITLE, contentType: "application/pdf", filename: "a.pdf", url: "https://x.example.org/a.pdf" });
		expect(sent[0]?.headers?.["Zotero-Write-Token"]).toMatch(/^[0-9a-f]{32}$/);
		expect(forms[0]?.path).toBe("/items/NEWATTCH/file");
	});

	it("reuses an earlier empty attachment instead of making another", async () => {
		const { zotero, sent, forms } = writer();
		await storePdf(zotero, "PARENTPA", { filename: "a.pdf", sourceUrl: "https://x.example.org/a.pdf", source: await src(), orphanKey: "OLDORPHA" }, ok);
		expect(sent).toHaveLength(0);
		expect(forms[0]?.path).toBe("/items/OLDORPHA/file");
	});

	it("moves the attachment it made to the trash if the upload fails, and never deletes", async () => {
		const { zotero, sent } = writer({ library: { "/items/NEWATTCH": reply({ key: "NEWATTCH", version: 9, data: { itemType: "attachment" } }) } });
		const refused = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
		await expect(storePdf(zotero, "PARENTPA", { filename: "a.pdf", sourceUrl: "https://x.example.org/a.pdf", source: await src() }, refused)).rejects.toThrow("HTTP 500");
		expect(sent.at(-1)).toMatchObject({ method: "PATCH", path: "/items/NEWATTCH", body: { deleted: 1 }, headers: { "If-Unmodified-Since-Version": "9" } });
		expect(sent.some((s) => s.method === "DELETE")).toBe(false);
	});

	it("leaves a reused attachment alone when the upload fails", async () => {
		const { zotero, sent } = writer();
		const refused = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
		await expect(storePdf(zotero, "PARENTPA", { filename: "a.pdf", sourceUrl: "https://x.example.org/a.pdf", source: await src(), orphanKey: "OLDORPHA" }, refused)).rejects.toThrow();
		expect(sent).toHaveLength(0);
	});

	it("tells a stored PDF from an empty attachment of ours", () => {
		const stored = item("STOREDPD", 1, { itemType: "attachment", contentType: "application/pdf", md5: "abc", parentItem: "P" });
		const orphan = item("ORPHANAT", 1, { itemType: "attachment", contentType: "application/pdf", title: ATTACHMENT_TITLE, parentItem: "P" });
		expect(hasStoredPdf([orphan])).toBe(false);
		expect(hasStoredPdf([stored])).toBe(true);
		expect(findOrphan([stored, orphan])?.key).toBe("ORPHANAT");
		expect(findOrphan([stored])).toBeUndefined();
	});
});

describe("extractText", () => {
	const converter = (convert: (bytes: number, name: string) => { format: string; data?: string; error?: string }): MarkdownConverter & { calls: number } => {
		const c = { calls: 0, async toMarkdown(file: { name: string; blob: Blob }) { c.calls++; return convert(file.blob.size, file.name); } };
		return c;
	};

	it("converts the whole file as plain text, without PDF metadata", async () => {
		let options: unknown;
		const ai: MarkdownConverter = { async toMarkdown(_file, o) { options = o; return { format: "text", data: "  Hello world.  " }; } };
		const out = await extractText(ai, "a.pdf", await pdfBytes(4));
		expect(out).toEqual({ text: "Hello world.", pages: 4, method: "whole" });
		expect(options).toEqual({ conversionOptions: { output: { format: "text" }, pdf: { metadata: false } } });
	});

	it("falls back to page ranges when the whole file cannot be converted", async () => {
		const whole = await pdfBytes(85);
		const ai = converter((size) => (size >= whole.byteLength ? { format: "error", error: "too big" } : { format: "text", data: `part(${size > 0 ? "ok" : ""})` }));
		const out = await extractText(ai, "big.pdf", whole);
		expect(out.method).toBe("chunks");
		expect(out.pages).toBe(85);
		expect(out.text.split("\n\n")).toHaveLength(3); // 40 + 40 + 5 pages
		expect(ai.calls).toBe(4); // the failed whole-file attempt, then three ranges
	});

	it("returns empty text for a PDF with no text layer", async () => {
		const out = await extractText({ async toMarkdown() { return { format: "text", data: "   " }; } }, "scan.pdf", await pdfBytes());
		expect(out.text).toBe("");
	});

	it("gives up cleanly when the PDF cannot be split either", async () => {
		await expect(extractText({ async toMarkdown() { return { format: "error", error: "bad" }; } }, "x.pdf", new TextEncoder().encode("%PDF-1.4 truncated"))).rejects.toThrow();
	});
});

describe("the pipeline", () => {
	const ai: MarkdownConverter = { async toMarkdown() { return { format: "text", data: "The full text of the paper." }; } };
	const paper = (extra: Record<string, unknown> = {}) => item("PARENTPA", 4, { title: "Reefs & heat: a study", DOI: "10.1/x", date: "2021-03-04", ...extra }, { creatorSummary: "Lovelace et al.", parsedDate: "2021-03-04" });
	const library = (parent: unknown, children: unknown[] = []) => ({ "/items/PARENTPA": reply(parent), "/items/PARENTPA/children": reply(children) });
	const openalex = (...urls: string[]) => ({ "https://api.openalex.org/works/doi:10.1/x?select=best_oa_location,locations": () => Response.json({ locations: urls.map((pdf_url) => ({ is_oa: true, pdf_url })) }) });
	const deps = (z: ZoteroWriter, fetchFn: typeof fetch): PipelineDeps => ({ zotero: z, ai, fetchFn });

	describe("locate", () => {
		it("plans a fetch for a paper with a DOI and no PDF, naming the file after it", async () => {
			const { zotero } = writer({ library: library(paper(), [item("NOTENOTE", 1, { itemType: "note", parentItem: "PARENTPA" })]) });
			const plan = await locate(deps(zotero, web(openalex("https://a.example.org/p.pdf")).fetchFn), "PARENTPA");
			expect(plan).toMatchObject({ parentKey: "PARENTPA", title: "Reefs & heat: a study", candidates: [{ url: "https://a.example.org/p.pdf" }] });
			expect(plan.filename).toBe("Lovelace et al. - 2021 - Reefs & heat a study.pdf");
			expect(plan.skip).toBeUndefined();
		});

		it("skips an item that is trashed, is not a paper, already has a PDF, has no DOI, or has nothing open access", async () => {
			const skipFor = async (parent: unknown, children: unknown[] = [], fetchFn = web(openalex()).fetchFn) => (await locate(deps(writer({ library: library(parent, children) }).zotero, fetchFn), "PARENTPA")).skip;
			expect(await skipFor(paper({ deleted: 1 }))).toContain("trash");
			expect(await skipFor(paper({ itemType: "note" }))).toContain("not a paper");
			expect(await skipFor(paper(), [item("A", 1, { itemType: "attachment", contentType: "application/pdf", md5: "abc", parentItem: "PARENTPA" })])).toContain("already has a PDF");
			expect(await skipFor(paper({ DOI: "" }))).toContain("no DOI");
			expect(await skipFor(paper())).toContain("No open-access PDF");
		});

		it("notes an earlier empty attachment of ours to reuse", async () => {
			const orphan = item("ORPHANAT", 1, { itemType: "attachment", contentType: "application/pdf", title: ATTACHMENT_TITLE, parentItem: "PARENTPA" });
			const plan = await locate(deps(writer({ library: library(paper(), [orphan]) }).zotero, web(openalex("https://a.example.org/p.pdf")).fetchFn), "PARENTPA");
			expect(plan.orphanKey).toBe("ORPHANAT");
		});
	});

	describe("store", () => {
		const plan = (...urls: string[]) => ({ parentKey: "PARENTPA", filename: "p.pdf", candidates: urls.map((url) => ({ url, source: "openalex" as const, license: "cc-by" })) });
		const uploadOk = (sizes?: number[]) => (async (_url: string, init: RequestInit) => { sizes?.push((await new Response(init.body).arrayBuffer()).byteLength); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;

		it("skips a link that returns a paywall page and uses the next one", async () => {
			const bytes = await pdfBytes(2);
			const web1 = web({ "https://a.example.org/gate": () => new Response("<html>login</html>"), "https://b.example.org/p.pdf": () => new Response(bytes, { headers: { "Content-Length": String(bytes.byteLength) } }) });
			const uploads: number[] = [];
			const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith("https://s3") ? uploadOk(uploads)(input, init) : web1.fetchFn(input, init))) as typeof fetch;
			const stored = await store(deps(writer().zotero, fetchFn), plan("https://a.example.org/gate", "https://b.example.org/p.pdf"));
			expect(stored).toMatchObject({ attachmentKey: "NEWATTCH", mode: "extract", size: bytes.byteLength, source: "https://b.example.org/p.pdf", license: "cc-by", upload: "uploaded" });
			expect(uploads[0]).toBeGreaterThan(bytes.byteLength);
		});

		it("streams a PDF over 20 MB twice, and uploads exactly its bytes, without extracting", async () => {
			const big = new Uint8Array(EXTRACT_MAX_BYTES + 1024 * 1024);
			big.set(new TextEncoder().encode("%PDF-1.4"));
			let fetches = 0;
			const web1 = web({ "https://a.example.org/big.pdf": () => (fetches++, new Response(big, { headers: { "Content-Length": String(big.byteLength) } })) });
			const uploaded: number[] = [];
			const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith("https://s3") ? uploadOk(uploaded)(input, init) : web1.fetchFn(input, init))) as typeof fetch;
			const stored = await store(deps(writer().zotero, fetchFn), plan("https://a.example.org/big.pdf"));
			expect(stored).toMatchObject({ mode: "store-only", size: big.byteLength });
			expect(fetches).toBe(2);
			expect(uploaded[0]).toBe(big.byteLength + "--x\r\nHEAD\r\n".length + "\r\n--x--".length);
		}, 60_000);

		it("stops, rather than trying other links, when Zotero itself refuses (storage full)", async () => {
			const bytes = await pdfBytes();
			let fetches = 0;
			const fetchFn = (async () => (fetches++, new Response(bytes, { headers: { "Content-Length": String(bytes.byteLength) } }))) as unknown as typeof fetch;
			const z = writer({ sendForm: async () => { throw new ZoteroError("quota", 413); }, library: { "/items/NEWATTCH": reply({ key: "NEWATTCH", version: 1, data: {} }) } }).zotero;
			await expect(store(deps(z, fetchFn), plan("https://a.example.org/1.pdf", "https://b.example.org/2.pdf"))).rejects.toMatchObject({ status: 413 });
			expect(fetches).toBe(1);
		});

		it("explains when no link gave a PDF", async () => {
			const fetchFn = web({ "https://a.example.org/x": () => new Response("<html>", { status: 200 }) }).fetchFn;
			await expect(store(deps(writer().zotero, fetchFn), plan("https://a.example.org/x", "https://b.example.org/y"))).rejects.toThrow(/None of the open-access links.*a\.example\.org.*b\.example\.org/);
		});
	});

	describe("extract", () => {
		const stored = (extra = {}) => ({ attachmentKey: "NEWATTCH", filename: "p.pdf", size: 1000, source: "https://a.example.org/p.pdf", mode: "extract" as const, upload: "uploaded" as const, ...extra });

		it("reads the stored PDF back and saves its text to Zotero as the attachment's full text", async () => {
			const bytes = await pdfBytes(7);
			const w = writer();
			const fetchFn = web({ "https://files.example.org/stored.pdf": () => new Response(bytes) }).fetchFn;
			const result = await extract(deps(w.zotero, fetchFn), stored());
			expect(result).toMatchObject({ extracted: true, pages: 7, characters: 27 });
			expect(w.sent[0]).toEqual({ method: "PUT", path: "/items/NEWATTCH/fulltext", body: { content: "The full text of the paper.", indexedPages: 7, totalPages: 7 }, headers: undefined });
		});

		it("leaves a large PDF for Zotero Desktop to index", async () => {
			const w = writer();
			const result = await extract(deps(w.zotero, web({}).fetchFn), stored({ mode: "store-only", size: 40 * 1048576 }));
			expect(result.extracted).toBe(false);
			expect(result.note).toContain("Zotero Desktop");
			expect(w.sent).toHaveLength(0);
		});

		it("says so when the PDF is scanned pages with no text, and writes nothing", async () => {
			const w = writer();
			const fetchFn = web({ "https://files.example.org/stored.pdf": async () => new Response(await pdfBytes()) }).fetchFn;
			const result = await extract({ ...deps(w.zotero, fetchFn), ai: { async toMarkdown() { return { format: "text", data: "" }; } } }, stored());
			expect(result).toMatchObject({ extracted: false });
			expect(result.note).toContain("no text layer");
			expect(w.sent).toHaveLength(0);
		});
	});
});
