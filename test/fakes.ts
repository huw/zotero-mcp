import type { IndexMetadata } from "../src/document";
import type { SearchIndex } from "../src/search-index";
import { BudgetExhausted, type Params, type ZoteroItem, ZoteroError, type ZoteroLike, type ZoteroResponse } from "../src/zotero";

export function item(key: string, version: number, data: Partial<ZoteroItem["data"]> & { itemType?: string } = {}, meta: ZoteroItem["meta"] = {}): ZoteroItem {
	return { key, version, meta, data: { itemType: "journalArticle", title: `Title ${key}`, ...data } };
}

/** A small in-memory Zotero library that answers the requests the sync makes. */
export class FakeZotero implements ZoteroLike {
	version = 10;
	items: ZoteroItem[] = [];
	fullText: Record<string, { content: string; version: number }> = {};
	deleted: string[] = [];
	calls: { path: string; params: Params }[] = [];

	constructor(private budget = Number.POSITIVE_INFINITY) {}

	hasBudget(count = 1) {
		return this.calls.length + count <= this.budget;
	}

	private reply(body: unknown, extra: Partial<ZoteroResponse> = {}): ZoteroResponse {
		return { status: 200, version: this.version, total: undefined, body: JSON.stringify(body), ...extra };
	}

	async get(path: string, params: Params = {}, headers: Record<string, string> = {}): Promise<ZoteroResponse> {
		if (!this.hasBudget()) {
			throw new BudgetExhausted();
		}
		this.calls.push({ path, params });

		if (path === "/items") {
			const since = Number(params.since ?? 0);
			if (headers["If-Modified-Since-Version"] && Number(headers["If-Modified-Since-Version"]) >= this.version) {
				return { status: 304, version: this.version, total: undefined, body: "" };
			}
			const keys = typeof params.itemKey === "string" ? params.itemKey.split(",") : undefined;
			const matching = this.items.filter((i) => i.version > since && (!keys || keys.includes(i.key)));
			const start = Number(params.start ?? 0);
			const page = matching.slice(start, start + Number(params.limit ?? 25));
			return this.reply(page, { total: matching.length });
		}
		const children = path.match(/^\/items\/(\w+)\/children$/);
		if (children) {
			return this.reply(this.items.filter((i) => i.data.parentItem === children[1]));
		}
		const fullText = path.match(/^\/items\/(\w+)\/fulltext$/);
		if (fullText) {
			const found = this.fullText[fullText[1] as string];
			if (!found) {
				throw new ZoteroError("not found", 404);
			}
			return this.reply({ content: found.content, indexedPages: 1, totalPages: 1 });
		}
		if (path === "/fulltext") {
			const since = Number(params.since ?? 0);
			return this.reply(Object.fromEntries(Object.entries(this.fullText).filter(([, v]) => v.version > since).map(([k, v]) => [k, v.version])));
		}
		if (path === "/deleted") {
			return this.reply({ items: this.deleted });
		}
		throw new Error(`FakeZotero: unhandled ${path}`);
	}
}

export class FakeIndex implements SearchIndex {
	docs = new Map<string, { text: string; metadata: IndexMetadata }>();
	ensured = 0;
	/** How many documents have been sent: each one is ingested, and charged for, by the real index. */
	upserts = 0;

	async ensure() {
		this.ensured++;
	}
	async upsert(key: string, text: string, metadata: IndexMetadata) {
		this.upserts++;
		this.docs.set(key, { text, metadata });
	}
	async remove(key: string) {
		this.docs.delete(key);
	}
}
