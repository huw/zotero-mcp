import type { CallToolResult } from "@modelcontextprotocol/server";
import { htmlToText } from "./document";
import { keyOf } from "./search-index";
import { parseJson, redact, type ZoteroItem, type ZoteroLike, ZoteroError } from "./zotero";

export type SemanticSearch = (query: string, limit: number, filters: VectorizeVectorMetadataFilter) => Promise<AiSearchSearchResponse>;

export type Deps = {
	zotero: ZoteroLike;
	search: SemanticSearch;
	/** Sync progress, for index_status. */
	status(): Promise<unknown>;
};

/** read: only reads. write: adds to the library and removes nothing. destructive: removes, overwrites or moves something that was there. */
export type ToolKind = "read" | "write" | "destructive";

export type Tool = {
	name: string;
	description: string;
	/** Defaults to "read". Claude shows each tool's setting on the connector, and the kind decides how it is annotated. */
	kind?: ToolKind;
	/** True if the tool reaches a site other than Zotero. */
	openWorld?: boolean;
	inputSchema: Record<string, unknown>;
	handler(input: Record<string, any>): Promise<CallToolResult>;
};

export const text = (value: unknown): CallToolResult => ({
	content: [{ type: "text", text: redact(typeof value === "string" ? value : JSON.stringify(value)) }],
});

const isEmpty = (value: unknown) =>
	value === "" || (Array.isArray(value) && value.length === 0) || (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);

/**
 * Zotero repeats the library and a set of links on every object, repeats the key and version inside `data`, and sends every
 * field the item type has, empty or not. The model needs none of that, and it adds up over a page of results.
 */
export function slim<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map(slim) as T;
	}
	if (value && typeof value === "object") {
		const { library: _library, links: _links, ...rest } = value as Record<string, unknown>;
		if (rest.data && typeof rest.data === "object") {
			const { key: _key, version: _version, ...data } = rest.data as Record<string, unknown>;
			rest.data = Object.fromEntries(Object.entries(data).filter(([, field]) => !isEmpty(field)));
		}
		return rest as T;
	}
	return value;
}

const limit = (max: number, fallback: number) => ({ type: "integer", minimum: 1, maximum: max, default: fallback });
const start = { type: "integer", minimum: 0, default: 0, description: "Offset into the results, for paging." };
export const key = (what: string) => ({ type: "string", pattern: "^[A-Z0-9]{8}$", description: `${what}: an 8-character Zotero key.` });

async function list(zotero: ZoteroLike, path: string, params: Record<string, string | number | undefined>) {
	const response = await zotero.get(path, { format: "json", ...params });
	const results = slim(parseJson<unknown[]>(response));
	return text({ total: response.total ?? results.length, start: Number(params.start ?? 0), returned: results.length, results });
}

export function createTools({ zotero, search, status }: Deps): Tool[] {
	return [
		{
			name: "search_items",
			description:
				"Search the library by keyword. qmode 'titleCreatorYear' (default) matches title, creators and year; 'everything' also searches the full text of attachments and notes. Filter by tag, item type or collection. Sort by dateAdded or dateModified to see recent additions. Returns top-level items (papers, books) with their metadata and the number of children.",
			inputSchema: {
				type: "object",
				properties: {
					q: { type: "string", description: "Search text. Omit to list items." },
					qmode: { enum: ["titleCreatorYear", "everything"], default: "titleCreatorYear" },
					tag: { type: "string", description: "A tag. Combine with ' || ' for OR, and prefix with '-' to exclude." },
					itemType: { type: "string", description: "e.g. 'journalArticle', 'book', or '-attachment' to exclude a type." },
					collection: key("Restrict to a collection"),
					sort: { enum: ["dateAdded", "dateModified", "title", "creator", "date", "itemType"], default: "dateModified" },
					direction: { enum: ["asc", "desc"], default: "desc" },
					limit: limit(100, 25),
					start,
				},
			},
			async handler(input) {
				const base = input.collection ? `/collections/${input.collection}/items/top` : "/items/top";
				return list(zotero, base, {
					q: input.q,
					qmode: input.q ? (input.qmode ?? "titleCreatorYear") : undefined,
					tag: input.tag,
					itemType: input.itemType,
					sort: input.sort ?? "dateModified",
					direction: input.direction ?? "desc",
					limit: input.limit ?? 25,
					start: input.start ?? 0,
				});
			},
		},
		{
			name: "get_item",
			description: "Get one item's full metadata: abstract, creators, DOI, tags, collections and so on.",
			inputSchema: { type: "object", properties: { key: key("The item") }, required: ["key"] },
			async handler(input) {
				return text(slim(parseJson(await zotero.get(`/items/${input.key}`, { format: "json" }))));
			},
		},
		{
			name: "get_item_children",
			description:
				"List an item's attachments (PDFs, snapshots) and notes. Notes come back as plain text; attachment keys are what get_fulltext reads.",
			inputSchema: { type: "object", properties: { key: key("The parent item") }, required: ["key"] },
			async handler(input) {
				const children = slim(parseJson<ZoteroItem[]>(await zotero.get(`/items/${input.key}/children`, { format: "json", limit: 100 })));
				return text(
					children.map((child) =>
						child.data.itemType === "note" ? { ...child, data: { ...child.data, note: htmlToText(child.data.note ?? "") } } : child,
					),
				);
			},
		},
		{
			name: "get_fulltext",
			description:
				"Read the text of a paper, as extracted and indexed by Zotero. Pass an item key (the first attachment with text is used) or an attachment key. Long documents come back in pieces: pass the returned nextOffset as offset to continue.",
			inputSchema: {
				type: "object",
				properties: {
					key: key("The item or its attachment"),
					offset: { type: "integer", minimum: 0, default: 0, description: "Character offset to start from." },
					length: { type: "integer", minimum: 1000, maximum: 50000, default: 20000, description: "How many characters to return." },
				},
				required: ["key"],
			},
			async handler(input) {
				const offset = input.offset ?? 0;
				const length = input.length ?? 20000;
				const read = async (attachment: string) =>
					parseJson<{ content?: string; indexedPages?: number; totalPages?: number }>(await zotero.get(`/items/${attachment}/fulltext`));

				let attachment: string = input.key;
				let result: Awaited<ReturnType<typeof read>> | undefined;
				try {
					result = await read(attachment);
				} catch (error) {
					if (!(error instanceof ZoteroError) || error.status !== 404) {
						throw error;
					}
					// Not an attachment with text, so treat the key as a parent item and look through its attachments.
					const children = parseJson<ZoteroItem[]>(await zotero.get(`/items/${input.key}/children`, { format: "json", limit: 100 }));
					for (const child of children.filter((c) => c.data.itemType === "attachment")) {
						try {
							result = await read(child.key);
							attachment = child.key;
							break;
						} catch (inner) {
							if (!(inner instanceof ZoteroError) || inner.status !== 404) {
								throw inner;
							}
						}
					}
				}
				if (!result?.content) {
					return { isError: true, ...text(`Zotero has no extracted text for ${input.key}. It may have no PDF, or Zotero desktop has not indexed it yet.`) };
				}
				const end = Math.min(offset + length, result.content.length);
				return text({
					attachment,
					content: result.content.slice(offset, end),
					offset,
					totalCharacters: result.content.length,
					nextOffset: end < result.content.length ? end : null,
					indexedPages: result.indexedPages,
					totalPages: result.totalPages,
				});
			},
		},
		{
			name: "list_collections",
			description: "List collections. By default the top-level ones; pass parent to list its subcollections, or all=true for every collection.",
			inputSchema: {
				type: "object",
				properties: { parent: key("A parent collection"), all: { type: "boolean", default: false }, limit: limit(100, 100), start },
			},
			async handler(input) {
				const path = input.parent ? `/collections/${input.parent}/collections` : input.all ? "/collections" : "/collections/top";
				return list(zotero, path, { limit: input.limit ?? 100, start: input.start ?? 0 });
			},
		},
		{
			name: "list_tags",
			description: "List tags with how often they are used, optionally only those within a collection or matching a prefix.",
			inputSchema: {
				type: "object",
				properties: { q: { type: "string", description: "Tags starting with this." }, collection: key("Only tags within this collection"), limit: limit(100, 100), start },
			},
			async handler(input) {
				const path = input.collection ? `/collections/${input.collection}/tags` : "/tags";
				return list(zotero, path, { q: input.q, limit: input.limit ?? 100, start: input.start ?? 0 });
			},
		},
		{
			name: "export_bibliography",
			description:
				"Format citations for up to 50 items, by key. 'bib' gives a formatted bibliography in a citation style (apa, chicago-author-date, harvard-cite-them-right, nature, ieee, vancouver, or any style id from the Zotero Style Repository). The others export raw data for a reference manager.",
			inputSchema: {
				type: "object",
				properties: {
					keys: { type: "array", items: key("An item"), minItems: 1, maxItems: 50 },
					format: { enum: ["bib", "bibtex", "biblatex", "ris", "csljson"], default: "bib" },
					style: { type: "string", default: "apa", description: "Citation style id, for format 'bib'." },
					locale: { type: "string", default: "en-US" },
				},
				required: ["keys"],
			},
			async handler(input) {
				const format = input.format ?? "bib";
				const response = await zotero.get("/items", {
					itemKey: input.keys.join(","),
					format,
					style: format === "bib" ? (input.style ?? "apa") : undefined,
					locale: format === "bib" ? (input.locale ?? "en-US") : undefined,
					limit: 50,
				});
				if (format !== "bib") {
					return text(response.body);
				}
				const entries = [...response.body.matchAll(/<div[^>]*class="csl-entry"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => htmlToText(m[1] ?? ""));
				return text(entries.length > 0 ? entries.join("\n\n") : htmlToText(response.body));
			},
		},
		{
			name: "semantic_search",
			description:
				"Search the library by meaning rather than keywords, over each paper's title, abstract, your notes and its full text. Use it for ideas and concepts (the papers may use different words); use search_items for names, titles and tags. Returns the best-matching passages, each with the Zotero item key to follow up with get_item or get_fulltext. Only items already synced to the search index appear: see index_status.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", minLength: 1 },
					limit: limit(20, 8),
					itemType: { type: "string", description: "Only this item type, e.g. 'journalArticle'." },
					yearFrom: { type: "integer", description: "Only items from this year on." },
					yearTo: { type: "integer", description: "Only items up to this year." },
				},
				required: ["query"],
			},
			async handler(input) {
				const filters: VectorizeVectorMetadataFilter = {};
				if (input.itemType) {
					filters.itemtype = input.itemType;
				}
				if (input.yearFrom !== undefined || input.yearTo !== undefined) {
					// Years are stored as four-digit text, which sorts the same as the numbers.
					filters.year = {
						...(input.yearFrom !== undefined ? { $gte: String(input.yearFrom) } : {}),
						...(input.yearTo !== undefined ? { $lte: String(input.yearTo) } : {}),
					};
				}
				const result = await search(input.query, input.limit ?? 8, filters);
				return text(
					result.chunks.map((chunk) => ({
						itemKey: keyOf(chunk.item.key),
						score: Number(chunk.score.toFixed(3)),
						passage: chunk.text,
						...chunk.item.metadata,
					})),
				);
			},
		},
		{
			name: "index_status",
			description: "How far the semantic search index has got: items waiting to be indexed, and the result of the last sync run.",
			inputSchema: { type: "object", properties: {} },
			async handler() {
				return text(await status());
			},
		},
	];
}
