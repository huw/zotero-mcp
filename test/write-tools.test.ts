import { describe, expect, it } from "vitest";
import type { Csl } from "../src/csl";
import { selectTools, writeModeOf, annotationsFor } from "../src/registry";
import { createTools, type Tool } from "../src/tools";
import { createWriteTools, textToNoteHtml } from "../src/write-tools";
import type { Params, ZoteroResponse, ZoteroWriter } from "../src/zotero";
import { item } from "./fakes";

type Sent = { method: string; path: string; body: unknown; headers: Record<string, string> };

const TEMPLATES: Record<string, Record<string, unknown>> = {
	journalArticle: { itemType: "journalArticle", title: "", creators: [], abstractNote: "", publicationTitle: "", volume: "", issue: "", pages: "", date: "", DOI: "", url: "", extra: "", tags: [], collections: [], relations: {} },
	book: { itemType: "book", title: "", creators: [], publisher: "", place: "", date: "", ISBN: "", extra: "", tags: [], collections: [], relations: {} },
	note: { itemType: "note", note: "", tags: [], collections: [], relations: {} },
};

function setup(library: ReturnType<typeof item>[] = [], reply: (sent: Sent) => ZoteroResponse = () => ok({ success: { "0": "NEWKEY12" }, successful: {}, unchanged: {}, failed: {} }), csl?: Csl) {
	const sent: Sent[] = [];
	const gets: { path: string; params: Params }[] = [];
	const zotero: ZoteroWriter = {
		hasBudget: () => true,
		async get(path, params = {}) {
			gets.push({ path, params });
			if (path === "/items") {
				const keys = typeof params.itemKey === "string" ? params.itemKey.split(",") : undefined;
				const hits = library.filter((i) => (keys ? keys.includes(i.key) : true) && (params.q ? i.data.DOI?.toLowerCase() === String(params.q).toLowerCase() : true));
				return ok(hits);
			}
			const collection = path.match(/^\/collections\/(\w+)$/);
			if (collection) {
				return ok({ key: collection[1], version: 77, data: { name: "Old name" } });
			}
			throw new Error(`unhandled get ${path}`);
		},
		async send(method, path, body, headers = {}) {
			const call = { method, path, body, headers };
			sent.push(call);
			return reply(call);
		},
		async itemTemplate(type) {
			const t = TEMPLATES[type];
			if (!t) throw new Error(`no template ${type}`);
			return t;
		},
	};
	const tools = createWriteTools({ zotero, resolveDoi: async () => csl ?? {} });
	const tool = (name: string) => tools.find((t) => t.name === name) as Tool;
	return { tools, tool, sent, gets };
}

const ok = (body: unknown, extra: Partial<ZoteroResponse> = {}): ZoteroResponse => ({ status: 200, version: 1, total: undefined, body: JSON.stringify(body), ...extra });
const parse = (r: Awaited<ReturnType<Tool["handler"]>>) => JSON.parse((r.content[0] as { text: string }).text);
const message = (r: Awaited<ReturnType<Tool["handler"]>>) => (r.content[0] as { text: string }).text;

const paper = (key: string, extra: Partial<ReturnType<typeof item>["data"]> = {}, version = 5) => item(key, version, { title: `Paper ${key}`, ...extra });

describe("what the server can and cannot do", () => {
	it("offers exactly these tools, and nothing that deletes for good or in bulk", () => {
		const { tools } = setup();
		const additive = tools.filter((t) => t.kind === "write").map((t) => t.name).sort();
		const destructive = tools.filter((t) => t.kind === "destructive").map((t) => t.name).sort();
		expect(additive).toEqual(["add_note", "add_paper_by_doi", "add_tags", "add_to_collection", "create_collection", "create_item", "restore_item"]);
		expect(destructive).toEqual(["delete_collection", "remove_from_collection", "remove_tags", "trash_item", "update_collection", "update_item", "update_note"]);
		// No tool is named for a permanent, bulk or library-wide removal, a sync, a file upload, or settings.
		expect(tools.map((t) => t.name).join(" ")).not.toMatch(/delete_item|delete_items|empty|purge|sync|upload|settings|library|bulk|delete_tag|delete_all/);
	});

	it("labels every destructive tool as such, in its description and its annotations", () => {
		const { tools } = setup();
		for (const tool of tools.filter((t) => t.kind === "destructive")) {
			expect(tool.description.startsWith("DESTRUCTIVE:")).toBe(true);
			expect(annotationsFor(tool)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		}
		for (const tool of tools.filter((t) => t.kind === "write")) {
			expect(annotationsFor(tool)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
			expect(tool.description.startsWith("DESTRUCTIVE")).toBe(false);
		}
	});

	it("registers tools according to the write mode, and treats anything unrecognised as off", () => {
		const { tools } = setup();
		const reads = createTools({ zotero: { hasBudget: () => true, get: async () => ok([]) }, search: async () => ({ search_query: "", chunks: [] }), status: async () => ({}) });
		const names = (mode: string) => selectTools(writeModeOf(mode), reads, tools).map((t) => t.name);

		expect(names("off")).toEqual(reads.map((t) => t.name));
		expect(names("typo")).toEqual(reads.map((t) => t.name));
		expect(names(undefined as unknown as string)).toEqual(reads.map((t) => t.name));
		expect(names("additive")).toContain("add_tags");
		expect(names("additive")).not.toContain("trash_item");
		expect(names("full")).toContain("trash_item");
		expect(annotationsFor(reads[0] as Tool)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		expect(annotationsFor(tools.find((t) => t.name === "add_paper_by_doi") as Tool).openWorldHint).toBe(true);
	});
});

describe("add_paper_by_doi", () => {
	const csl: Csl = { type: "article-journal", title: "Reefs and heat", author: [{ given: "Ada", family: "Lovelace" }], "container-title": "Nature", issued: { "date-parts": [[2021, 3]] }, DOI: "10.1000/xyz", volume: 5 };

	it("creates the item with a write token and refuses nothing it did not need to", async () => {
		const { tool, sent } = setup([], undefined, csl);
		const result = await tool("add_paper_by_doi").handler({ doi: "https://doi.org/10.1000/XYZ", tags: ["to-read"], collections: ["COLLCOLL"] });

		expect(result.isError).toBeUndefined();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ method: "POST", path: "/items" });
		expect(sent[0]?.headers["Zotero-Write-Token"]).toMatch(/^[0-9a-f]{32}$/);
		expect((sent[0]?.body as unknown[])[0]).toMatchObject({
			itemType: "journalArticle", title: "Reefs and heat", date: "2021-03", publicationTitle: "Nature", DOI: "10.1000/xyz", volume: "5",
			creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }], tags: [{ tag: "to-read" }], collections: ["COLLCOLL"],
		});
		expect(parse(result)).toMatchObject({ added: true, saved: ["NEWKEY12"], title: "Reefs and heat" });
	});

	it("adds nothing when the DOI is already in the library, whatever its case", async () => {
		const { tool, sent } = setup([paper("AAAAAAAA", { DOI: "10.1000/XYZ" })], undefined, csl);
		const result = parse(await tool("add_paper_by_doi").handler({ doi: "10.1000/xyz" }));
		expect(result).toMatchObject({ added: false, key: "AAAAAAAA" });
		expect(sent).toHaveLength(0);
	});

	it("rejects something that is not a DOI before it reaches the network", async () => {
		const { tool, sent } = setup();
		const result = await tool("add_paper_by_doi").handler({ doi: "https://evil.example/10.1000/x" });
		expect(result.isError).toBe(true);
		expect(message(result)).toContain("not a DOI");
		expect(sent).toHaveLength(0);
	});

	it("reports Zotero's refusal as an error", async () => {
		const { tool } = setup([], () => ok({ success: {}, successful: {}, unchanged: {}, failed: { "0": { code: 400, message: "'foo' is not a valid field" } } }), csl);
		const result = await tool("add_paper_by_doi").handler({ doi: "10.1000/xyz" });
		expect(result.isError).toBe(true);
		expect(message(result)).toContain("not a valid field");
	});
});

describe("create_item", () => {
	it("refuses a field the type lacks and says what it does allow", async () => {
		const { tool, sent } = setup();
		const result = await tool("create_item").handler({ itemType: "book", fields: { title: "A book", publicationTitle: "Nope" } });
		expect(result.isError).toBe(true);
		expect(message(result)).toMatch(/book has no field called publicationTitle.*publisher/);
		expect(sent).toHaveLength(0);
	});

	it("refuses fields that have their own tools or that Zotero manages", async () => {
		const { tool, sent } = setup();
		for (const field of ["deleted", "collections", "tags", "version", "parentItem", "relations"]) {
			const result = await tool("create_item").handler({ itemType: "book", fields: { [field]: "x" } });
			expect(result.isError, field).toBe(true);
		}
		expect(sent).toHaveLength(0);
	});

	it("creates an allowed item", async () => {
		const { tool, sent } = setup();
		await tool("create_item").handler({ itemType: "book", fields: { title: "A book", publisher: "Pub" }, creators: [{ creatorType: "author", name: "WHO" }] });
		expect((sent[0]?.body as unknown[])[0]).toEqual({ itemType: "book", title: "A book", publisher: "Pub", creators: [{ creatorType: "author", name: "WHO" }] });
	});
});

describe("batch changes check each item's version and write only what changes", () => {
	it("add_tags keeps existing tags and skips items that already have them", async () => {
		const { tool, sent } = setup([paper("AAAAAAAA", { tags: [{ tag: "old" }] }, 11), paper("BBBBBBBB", { tags: [{ tag: "new" }] }, 12)]);
		const result = parse(await tool("add_tags").handler({ keys: ["AAAAAAAA", "BBBBBBBB"], tags: ["new"] }));

		expect(sent[0]?.body).toEqual([{ key: "AAAAAAAA", version: 11, tags: [{ tag: "old" }, { tag: "new" }] }]);
		expect(result.unchanged).toContain("BBBBBBBB");
	});

	it("does not write at all when nothing changes", async () => {
		const { tool, sent } = setup([paper("AAAAAAAA", { tags: [{ tag: "x" }] })]);
		const result = parse(await tool("add_tags").handler({ keys: ["AAAAAAAA"], tags: ["x"] }));
		expect(sent).toHaveLength(0);
		expect(result).toEqual({ saved: [], unchanged: ["AAAAAAAA"], failed: [] });
	});

	it("add_to_collection and remove_from_collection edit the collection list", async () => {
		const library = [paper("AAAAAAAA", { collections: ["ONEONEON"] } as never, 3)];
		const add = setup(library);
		await add.tool("add_to_collection").handler({ keys: ["AAAAAAAA"], collection: "TWOTWOTW" });
		expect(add.sent[0]?.body).toEqual([{ key: "AAAAAAAA", version: 3, collections: ["ONEONEON", "TWOTWOTW"] }]);

		const remove = setup(library);
		await remove.tool("remove_from_collection").handler({ keys: ["AAAAAAAA"], collection: "ONEONEON" });
		expect(remove.sent[0]?.body).toEqual([{ key: "AAAAAAAA", version: 3, collections: [] }]);
	});

	it("remove_tags leaves other tags alone", async () => {
		const { tool, sent } = setup([paper("AAAAAAAA", { tags: [{ tag: "a" }, { tag: "b" }] })]);
		await tool("remove_tags").handler({ keys: ["AAAAAAAA"], tags: ["a"] });
		expect((sent[0]?.body as { tags: unknown }[])[0]?.tags).toEqual([{ tag: "b" }]);
	});

	it("refuses a key that is not in the library, and writes nothing", async () => {
		const { tool, sent } = setup([paper("AAAAAAAA")]);
		await expect(tool("add_tags").handler({ keys: ["AAAAAAAA", "ZZZZZZZZ"], tags: ["x"] })).rejects.toThrow("No such item: ZZZZZZZZ");
		expect(sent).toHaveLength(0);
	});
});

describe("single-item changes", () => {
	it("trash_item moves one item to the trash, guarded by its version, and never deletes", async () => {
		const { tool, sent } = setup([paper("AAAAAAAA", {}, 42)], () => ({ status: 204, version: 43, total: undefined, body: "" }));
		const result = parse(await tool("trash_item").handler({ key: "AAAAAAAA" }));
		expect(sent).toEqual([{ method: "PATCH", path: "/items/AAAAAAAA", body: { deleted: 1 }, headers: { "If-Unmodified-Since-Version": "42" } }]);
		expect(sent.some((s) => s.method === "DELETE")).toBe(false);
		expect(result).toMatchObject({ trashed: "AAAAAAAA" });
	});

	it("restore_item takes it back out", async () => {
		const { tool, sent } = setup([paper("AAAAAAAA", { deleted: 1 }, 50)], () => ({ status: 204, version: 51, total: undefined, body: "" }));
		await tool("restore_item").handler({ key: "AAAAAAAA" });
		expect(sent[0]).toMatchObject({ method: "PATCH", body: { deleted: 0 }, headers: { "If-Unmodified-Since-Version": "50" } });
	});

	it("update_item changes allowed fields only, and checks the version", async () => {
		const { tool, sent } = setup([paper("AAAAAAAA", {}, 9)], () => ({ status: 204, version: 10, total: undefined, body: "" }));
		await tool("update_item").handler({ key: "AAAAAAAA", fields: { title: "New title", date: "2020" } });
		expect(sent[0]).toEqual({ method: "PATCH", path: "/items/AAAAAAAA", body: { title: "New title", date: "2020" }, headers: { "If-Unmodified-Since-Version": "9" } });

		const refused = await tool("update_item").handler({ key: "AAAAAAAA", fields: { deleted: "1" } });
		expect(refused.isError).toBe(true);
		const empty = await tool("update_item").handler({ key: "AAAAAAAA" });
		expect(empty.isError).toBe(true);
		expect(sent).toHaveLength(1);
	});

	it("update_note refuses something that is not a note", async () => {
		const { tool, sent } = setup([paper("AAAAAAAA")]);
		const result = await tool("update_note").handler({ key: "AAAAAAAA", note: "hello" });
		expect(result.isError).toBe(true);
		expect(sent).toHaveLength(0);
	});

	it("add_note turns plain text into escaped HTML under an existing item", async () => {
		const { tool, sent } = setup([paper("AAAAAAAA")]);
		await tool("add_note").handler({ parent: "AAAAAAAA", note: "Line one\nline two\n\nA <b>tag</b> & more" });
		expect((sent[0]?.body as { note: string }[])[0]).toMatchObject({
			itemType: "note", parentItem: "AAAAAAAA", note: "<p>Line one<br>line two</p>\n<p>A &lt;b&gt;tag&lt;/b&gt; &amp; more</p>",
		});
		expect(textToNoteHtml("  x  ")).toBe("<p>x</p>");
	});
});

describe("collections", () => {
	it("create_collection can nest, and defaults to the top level", async () => {
		const { tool, sent } = setup();
		await tool("create_collection").handler({ name: "Reviews" });
		await tool("create_collection").handler({ name: "Sub", parent: "PARENTPA" });
		expect(sent.map((s) => (s.body as unknown[])[0])).toEqual([{ name: "Reviews", parentCollection: false }, { name: "Sub", parentCollection: "PARENTPA" }]);
	});

	it("update_collection renames or moves, with the collection's version", async () => {
		const { tool, sent } = setup([], () => ({ status: 204, version: 78, total: undefined, body: "" }));
		await tool("update_collection").handler({ key: "COLLCOLL", name: "New", parent: null });
		expect(sent[0]).toEqual({ method: "PATCH", path: "/collections/COLLCOLL", body: { name: "New", parentCollection: false }, headers: { "If-Unmodified-Since-Version": "77" } });
		expect((await tool("update_collection").handler({ key: "COLLCOLL" })).isError).toBe(true);
	});

	it("delete_collection deletes exactly one collection, guarded by its version", async () => {
		const { tool, sent } = setup([], () => ({ status: 204, version: 79, total: undefined, body: "" }));
		await tool("delete_collection").handler({ key: "COLLCOLL" });
		expect(sent).toEqual([{ method: "DELETE", path: "/collections/COLLCOLL", body: undefined, headers: { "If-Unmodified-Since-Version": "77" } }]);
	});
});
