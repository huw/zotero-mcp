import { describe, expect, it } from "vitest";
import { createTools, type Deps, type Tool } from "../src/tools";
import { BudgetExhausted, type Params, ZoteroError, type ZoteroLike, type ZoteroResponse } from "../src/zotero";

type Handler = (path: string, params: Params) => ZoteroResponse | Promise<ZoteroResponse>;

function setup(handler: Handler, search: Deps["search"] = async () => ({ search_query: "", chunks: [] })) {
	const calls: { path: string; params: Params }[] = [];
	const zotero: ZoteroLike = {
		hasBudget: () => true,
		async get(path, params = {}) {
			calls.push({ path, params });
			return handler(path, params);
		},
	};
	const tools = createTools({ zotero, search, status: async () => ({ ok: true }) });
	const tool = (name: string) => tools.find((t) => t.name === name) as Tool;
	return { calls, tools, tool };
}

const json = (body: unknown, extra: Partial<ZoteroResponse> = {}): ZoteroResponse => ({ status: 200, version: 1, total: undefined, body: JSON.stringify(body), ...extra });
const textOf = (result: Awaited<ReturnType<Tool["handler"]>>) => (result.content[0] as { text: string }).text;

describe("tool surface", () => {
	it("exposes the documented tools, each with an object schema", () => {
		const { tools } = setup(() => json([]));
		expect(tools.map((t) => t.name)).toEqual([
			"search_items",
			"get_item",
			"get_item_children",
			"get_fulltext",
			"list_collections",
			"list_tags",
			"export_bibliography",
			"semantic_search",
			"index_status",
		]);
		for (const tool of tools) {
			expect(tool.inputSchema.type).toBe("object");
			expect(tool.description.length).toBeGreaterThan(20);
		}
	});
});

describe("search_items", () => {
	it("searches top-level items, defaulting to title/creator/year, and wraps results with paging info", async () => {
		const { tool, calls } = setup(() => json([{ key: "AAAAAAAA", library: { id: 1 }, links: {}, data: { title: "x" } }], { total: 40 }));
		const result = JSON.parse(textOf(await tool("search_items").handler({ q: "coral" })));

		expect(calls[0]).toMatchObject({ path: "/items/top", params: { q: "coral", qmode: "titleCreatorYear", sort: "dateModified", direction: "desc", limit: 25, start: 0 } });
		expect(result).toMatchObject({ total: 40, start: 0, returned: 1 });
		// Zotero's library and links boilerplate is dropped.
		expect(result.results[0]).toEqual({ key: "AAAAAAAA", data: { title: "x" } });
	});

	it("drops empty fields and the key and version repeated inside data", async () => {
		const full = { key: "AAAAAAAA", version: 3, library: { id: 1 }, data: { key: "AAAAAAAA", version: 3, itemType: "book", title: "T", publisher: "", place: "", tags: [], relations: {}, extra: "", parentCollection: false, DOI: "10.1/x" } };
		const { tool } = setup(() => json([full]));
		const result = JSON.parse(textOf(await tool("search_items").handler({})));
		expect(result.results[0]).toEqual({ key: "AAAAAAAA", version: 3, data: { itemType: "book", title: "T", parentCollection: false, DOI: "10.1/x" } });
	});

	it("searches inside a collection and in full text when asked", async () => {
		const { tool, calls } = setup(() => json([]));
		await tool("search_items").handler({ q: "bleaching", qmode: "everything", collection: "COLLCOLL", tag: "coral", itemType: "-attachment" });
		expect(calls[0]).toMatchObject({ path: "/collections/COLLCOLL/items/top", params: { qmode: "everything", tag: "coral", itemType: "-attachment" } });
	});

	it("sends no qmode without a query", async () => {
		const { tool, calls } = setup(() => json([]));
		await tool("search_items").handler({ sort: "dateAdded" });
		expect(calls[0]?.params.qmode).toBeUndefined();
		expect(calls[0]?.params.sort).toBe("dateAdded");
	});
});

describe("get_item_children", () => {
	it("turns note HTML into text", async () => {
		const { tool } = setup(() => json([{ key: "N", data: { itemType: "note", note: "<p>Hello &amp; <b>bye</b></p>" } }]));
		const result = JSON.parse(textOf(await tool("get_item_children").handler({ key: "AAAAAAAA" })));
		expect(result[0].data.note).toBe("Hello & bye");
	});
});

describe("get_fulltext", () => {
	const content = "abcdefghij".repeat(3000);

	it("reads in pieces and says where to continue", async () => {
		const { tool } = setup(() => json({ content, indexedPages: 9, totalPages: 9 }));
		const first = JSON.parse(textOf(await tool("get_fulltext").handler({ key: "PDFPDFPD", length: 20000 })));
		expect(first).toMatchObject({ attachment: "PDFPDFPD", offset: 0, totalCharacters: 30000, nextOffset: 20000, totalPages: 9 });
		expect(first.content).toHaveLength(20000);

		const last = JSON.parse(textOf(await tool("get_fulltext").handler({ key: "PDFPDFPD", offset: 20000 })));
		expect(last.content).toHaveLength(10000);
		expect(last.nextOffset).toBeNull();
	});

	it("falls back to the attachments of a parent item", async () => {
		const { tool } = setup((path) => {
			if (path === "/items/AAAAAAAA/fulltext") {
				throw new ZoteroError("not found", 404);
			}
			if (path === "/items/AAAAAAAA/children") {
				return json([{ key: "NOTENOTE", data: { itemType: "note" } }, { key: "SNAPSNAP", data: { itemType: "attachment" } }, { key: "PDFPDFPD", data: { itemType: "attachment" } }]);
			}
			if (path === "/items/SNAPSNAP/fulltext") {
				throw new ZoteroError("not found", 404);
			}
			return json({ content: "from the pdf" });
		});
		const result = JSON.parse(textOf(await tool("get_fulltext").handler({ key: "AAAAAAAA" })));
		expect(result).toMatchObject({ attachment: "PDFPDFPD", content: "from the pdf" });
	});

	it("explains when there is no text", async () => {
		const { tool } = setup((path) => {
			if (path.endsWith("/children")) {
				return json([]);
			}
			throw new ZoteroError("not found", 404);
		});
		const result = await tool("get_fulltext").handler({ key: "AAAAAAAA" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("no extracted text");
	});

	it("lets other errors through", async () => {
		const { tool } = setup(() => {
			throw new ZoteroError("forbidden", 403);
		});
		await expect(tool("get_fulltext").handler({ key: "AAAAAAAA" })).rejects.toThrow("forbidden");
	});
});

describe("export_bibliography", () => {
	it("formats citations as plain text entries", async () => {
		const html = '<div class="csl-bib-body"><div data-csl-entry-id="x" class="csl-entry">Lovelace, A. (2021). <i>Reefs &amp; heat</i>.</div><div class="csl-entry">Babbage, C. (1830).</div></div>';
		const { tool, calls } = setup(() => ({ status: 200, version: 1, total: undefined, body: html }));
		const result = await tool("export_bibliography").handler({ keys: ["AAAAAAAA", "BBBBBBBB"], style: "chicago-author-date" });

		expect(calls[0]).toMatchObject({ path: "/items", params: { itemKey: "AAAAAAAA,BBBBBBBB", format: "bib", style: "chicago-author-date", locale: "en-US" } });
		expect(textOf(result)).toBe("Lovelace, A. (2021). Reefs & heat.\n\nBabbage, C. (1830).");
	});

	it("decodes the hex entities Zotero uses for dashes and accents", async () => {
		const html = '<div class="csl-bib-body"><div class="csl-entry">Hong, J. (2018). Health Outcomes, 16, 363&#x2013;372. Caf&#xE9;.</div></div>';
		const { tool } = setup(() => ({ status: 200, version: 1, total: undefined, body: html }));
		expect(textOf(await tool("export_bibliography").handler({ keys: ["AAAAAAAA"] }))).toBe("Hong, J. (2018). Health Outcomes, 16, 363\u2013372. Caf\u00e9.");
	});

	it("passes raw formats through without a style", async () => {
		const { tool, calls } = setup(() => ({ status: 200, version: 1, total: undefined, body: "@article{a}" }));
		const result = await tool("export_bibliography").handler({ keys: ["AAAAAAAA"], format: "bibtex" });
		expect(calls[0]?.params).toMatchObject({ format: "bibtex", style: undefined });
		expect(textOf(result)).toBe("@article{a}");
	});
});

describe("semantic_search", () => {
	const response = {
		search_query: "q",
		chunks: [{ id: "c1", type: "text", score: 0.81234, text: "Corals bleach.", item: { key: "AAAAAAAA.md", metadata: { title: "Reefs", year: "2021" } } }],
	} as AiSearchSearchResponse;

	it("maps filters and returns passages with their Zotero keys", async () => {
		let seen: unknown[] = [];
		const { tool } = setup(() => json([]), async (...args: unknown[]) => {
			seen = args;
			return response;
		});
		const result = JSON.parse(textOf(await tool("semantic_search").handler({ query: "heat stress", itemType: "journalArticle", yearFrom: 2015, yearTo: 2022 })));

		expect(seen).toEqual(["heat stress", 8, { itemtype: "journalArticle", year: { $gte: "2015", $lte: "2022" } }]);
		expect(result).toEqual([{ itemKey: "AAAAAAAA", score: 0.812, passage: "Corals bleach.", title: "Reefs", year: "2021" }]);
	});

	it("sends no filter when none is asked for", async () => {
		let filters: unknown;
		const { tool } = setup(() => json([]), async (_q: unknown, _l: unknown, f: unknown) => {
			filters = f;
			return response;
		});
		await tool("semantic_search").handler({ query: "x" });
		expect(filters).toEqual({});
	});
});

describe("redaction", () => {
	it("never returns the API key, even if Zotero echoes it", async () => {
		const { tool } = setup(() => json({ note: "key is test-zotero-key" }));
		expect(textOf(await tool("get_item").handler({ key: "AAAAAAAA" }))).not.toContain("test-zotero-key");
	});
});

describe("budget", () => {
	it("BudgetExhausted is a plain error the sync can recognise", () => {
		expect(new BudgetExhausted()).toBeInstanceOf(Error);
	});
});
