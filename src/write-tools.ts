import type { CallToolResult } from "@modelcontextprotocol/server";
import { type Csl, cslToItem, normalizeDoi, resolveDoi, zoteroTypeOf } from "./csl";
import { key, slim, text, type Tool } from "./tools";
import { parseJson, type ZoteroItem, type ZoteroResponse, type ZoteroWriter } from "./zotero";

/**
 * What this server will not do, on purpose: delete anything for good (items go to Zotero's trash, where they can be
 * restored), delete in bulk, empty the trash, delete tags library-wide, upload files, touch group libraries, or change
 * settings or keys. Nothing here can sync, either: Zotero Desktop does that.
 */
export type WriteDeps = {
	zotero: ZoteroWriter;
	/** Looks up a DOI's metadata. Replaceable so tests need no network. */
	resolveDoi?: (doi: string) => Promise<Csl>;
};

const MAX_KEYS = 50;
/** Fields the tools set through their own arguments or that Zotero manages. update_item and create_item refuse them. */
const PROTECTED = new Set([
	"key", "version", "itemType", "dateAdded", "dateModified", "collections", "deleted", "parentItem", "relations", "tags", "creators",
	"linkMode", "md5", "mtime", "filename", "contentType", "charset", "library", "links", "meta",
]);

const keys = { type: "array", items: key("An item"), minItems: 1, maxItems: MAX_KEYS, uniqueItems: true };
const tagList = { type: "array", items: { type: "string", minLength: 1, maxLength: 255 }, minItems: 1, maxItems: 20 };
const creatorsSchema = {
	type: "array",
	maxItems: 50,
	description: "Each is { creatorType: 'author', firstName, lastName } or, for an organisation, { creatorType: 'author', name }.",
	items: {
		type: "object",
		properties: { creatorType: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" }, name: { type: "string" } },
		required: ["creatorType"],
		additionalProperties: false,
	},
};
const fieldsSchema = {
	type: "object",
	description: "Zotero field names to text values, e.g. { title, date, publicationTitle, volume, pages, DOI, url, abstractNote }. The fields allowed depend on the item type.",
	additionalProperties: { type: "string", maxLength: 20000 },
	maxProperties: 40,
};

const writeToken = () => crypto.randomUUID().replaceAll("-", "");
const failure = (message: string): CallToolResult => ({ isError: true, ...text(message) });

type MultiWrite = {
	successful?: Record<string, ZoteroItem>;
	success?: Record<string, string>;
	unchanged?: Record<string, string>;
	failed?: Record<string, { key?: string; code: number; message: string }>;
};

/** Zotero answers a batch write item by item. Collect which were saved, which already matched, and which it refused. */
function outcome(response: ZoteroResponse, extra: Record<string, unknown> = {}): CallToolResult {
	const body = parseJson<MultiWrite>(response);
	// Zotero reports saved objects as keys under `success` and as full objects under `successful`. Accept either.
	const saved = body.success ? Object.values(body.success) : Object.values(body.successful ?? {}).map((saved) => saved.key);
	const unchanged = Object.values(body.unchanged ?? {});
	const failed = Object.values(body.failed ?? {}).map((f) => ({ key: f.key, code: f.code, message: f.message }));
	const result = { saved, unchanged, failed, ...extra };
	return failed.length > 0 && saved.length === 0 && unchanged.length === 0 ? { isError: true, ...text(result) } : text(result);
}

const SCAN_PAGE = 100;
const SCAN_MAX_PAGES = 40;

/**
 * Zotero's search cannot find an item by DOI: a DOI in q matches nothing, in either search mode. So look through the
 * library's own DOI fields, a page at a time, stopping at the first match.
 */
async function findByDoi(zotero: ZoteroWriter, doi: string) {
	const wanted = doi.toLowerCase();
	for (let page = 0; page < SCAN_MAX_PAGES; page++) {
		const response = await zotero.get("/items/top", { format: "json", limit: SCAN_PAGE, start: page * SCAN_PAGE });
		const items = parseJson<ZoteroItem[]>(response);
		const match = items.find((item) => item.data.DOI?.toLowerCase() === wanted);
		if (match) {
			return match;
		}
		if (items.length < SCAN_PAGE || (response.total !== undefined && (page + 1) * SCAN_PAGE >= response.total)) {
			return undefined;
		}
	}
	return undefined;
}

export async function fetchItems(zotero: ZoteroWriter, itemKeys: string[]) {
	const response = await zotero.get("/items", { itemKey: itemKeys.join(","), format: "json", includeTrashed: 1, limit: MAX_KEYS });
	const found = new Map(parseJson<ZoteroItem[]>(response).map((item) => [item.key, item]));
	const missing = itemKeys.filter((k) => !found.has(k));
	if (missing.length > 0) {
		throw new Error(`No such item: ${missing.join(", ")}.`);
	}
	return found;
}

async function fetchItem(zotero: ZoteroWriter, itemKey: string) {
	return (await fetchItems(zotero, [itemKey])).get(itemKey) as ZoteroItem;
}

/** Reads each item, lets `change` say what to set on it, and writes only the ones that change, checking each item's version so a concurrent edit is not overwritten. */
async function modify(zotero: ZoteroWriter, itemKeys: string[], change: (data: ZoteroItem["data"]) => Record<string, unknown> | undefined) {
	const found = await fetchItems(zotero, itemKeys);
	const updates = itemKeys.flatMap((k) => {
		const item = found.get(k) as ZoteroItem;
		const patch = change(item.data);
		return patch ? [{ key: k, version: item.version, ...patch }] : [];
	});
	if (updates.length === 0) {
		return text({ saved: [], unchanged: itemKeys, failed: [] });
	}
	// Each update carries its item's version, which already stops a repeat or a clash, so no write token (Zotero says to omit it).
	const response = await zotero.send("POST", "/items", updates);
	const result = outcome(response);
	const unchangedHere = itemKeys.filter((k) => !updates.some((u) => u.key === k));
	if (unchangedHere.length > 0 && !result.isError) {
		const body = JSON.parse((result.content[0] as { text: string }).text);
		body.unchanged = [...body.unchanged, ...unchangedHere];
		return text(body);
	}
	return result;
}

/** Plain text to the small HTML Zotero stores notes as: paragraphs on blank lines, line breaks on single newlines. */
export function textToNoteHtml(note: string) {
	const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	return note
		.trim()
		.split(/\n{2,}/)
		.map((paragraph) => `<p>${escape(paragraph).replaceAll("\n", "<br>")}</p>`)
		.join("\n");
}

async function checkFields(zotero: ZoteroWriter, itemType: string, fields: Record<string, string> = {}) {
	const template = await zotero.itemTemplate(itemType);
	const allowed = Object.keys(template).filter((field) => !PROTECTED.has(field));
	const refused = Object.keys(fields).filter((field) => !allowed.includes(field));
	if (refused.length > 0) {
		throw new Error(
			PROTECTED.has(refused[0] as string)
				? `${refused.join(", ")} cannot be set this way. Use the dedicated tool (tags, collections, trash) instead.`
				: `A ${itemType} has no field called ${refused.join(", ")}. Fields it allows: ${allowed.join(", ")}.`,
		);
	}
	return template;
}

export function createWriteTools({ zotero, resolveDoi: resolve = resolveDoi }: WriteDeps): Tool[] {
	return [
		{
			name: "add_paper_by_doi",
			kind: "write",
			openWorld: true,
			description:
				"Save a paper to the library from its DOI. The metadata (title, authors, journal, date, abstract) comes from doi.org. If the DOI is already in the library nothing is added and the existing item is returned. Optionally file it in collections and tag it. Does not attach a PDF.",
			inputSchema: {
				type: "object",
				properties: {
					doi: { type: "string", description: "A DOI, 'doi:10...', or a doi.org link." },
					collections: { type: "array", items: key("A collection"), maxItems: 10 },
					tags: tagList,
				},
				required: ["doi"],
			},
			async handler(input) {
				let doi: string;
				try {
					doi = normalizeDoi(input.doi);
				} catch (error) {
					return failure((error as Error).message);
				}
				const existing = await findByDoi(zotero, doi);
				if (existing) {
					return text({ added: false, reason: "Already in the library.", key: existing.key, title: existing.data.title });
				}

				const csl = await resolve(doi);
				const template = await zotero.itemTemplate(zoteroTypeOf(csl));
				const item: Record<string, unknown> = {
					...cslToItem(csl, template),
					...(input.collections ? { collections: input.collections } : {}),
					...(input.tags ? { tags: (input.tags as string[]).map((tag) => ({ tag })) } : {}),
				};
				return outcome(await zotero.send("POST", "/items", [item], { "Zotero-Write-Token": writeToken() }), {
					added: true,
					title: item.title,
					itemType: item.itemType,
				});
			},
		},
		{
			name: "create_item",
			kind: "write",
			description:
				"Add an item by hand, for something with no DOI (a web page, report, book, preprint). Use add_paper_by_doi when there is a DOI. The fields allowed depend on the item type, and a field the type lacks is refused with the list it does allow.",
			inputSchema: {
				type: "object",
				properties: {
					itemType: { type: "string", description: "e.g. journalArticle, book, bookSection, conferencePaper, report, thesis, preprint, webpage." },
					fields: fieldsSchema,
					creators: creatorsSchema,
					tags: tagList,
					collections: { type: "array", items: key("A collection"), maxItems: 10 },
				},
				required: ["itemType", "fields"],
			},
			async handler(input) {
				try {
					await checkFields(zotero, input.itemType, input.fields);
				} catch (error) {
					return failure((error as Error).message);
				}
				const item = {
					itemType: input.itemType,
					...input.fields,
					...(input.creators ? { creators: input.creators } : {}),
					...(input.tags ? { tags: (input.tags as string[]).map((tag) => ({ tag })) } : {}),
					...(input.collections ? { collections: input.collections } : {}),
				};
				return outcome(await zotero.send("POST", "/items", [item], { "Zotero-Write-Token": writeToken() }));
			},
		},
		{
			name: "add_note",
			kind: "write",
			description: "Add a note to an item, from plain text. Blank lines make paragraphs.",
			inputSchema: {
				type: "object",
				properties: { parent: key("The item to attach the note to"), note: { type: "string", minLength: 1, maxLength: 50000 } },
				required: ["parent", "note"],
			},
			async handler(input) {
				await fetchItem(zotero, input.parent);
				const item = { itemType: "note", parentItem: input.parent, note: textToNoteHtml(input.note) };
				return outcome(await zotero.send("POST", "/items", [item], { "Zotero-Write-Token": writeToken() }));
			},
		},
		{
			name: "add_tags",
			kind: "write",
			description: "Add tags to up to 50 items. Tags an item already has are left alone.",
			inputSchema: { type: "object", properties: { keys, tags: tagList }, required: ["keys", "tags"] },
			async handler(input) {
				const wanted = input.tags as string[];
				return modify(zotero, input.keys, (data) => {
					const have = new Set((data.tags ?? []).map((t) => t.tag));
					const added = wanted.filter((tag) => !have.has(tag));
					return added.length > 0 ? { tags: [...(data.tags ?? []), ...added.map((tag) => ({ tag }))] } : undefined;
				});
			},
		},
		{
			name: "add_to_collection",
			kind: "write",
			description: "Put up to 50 items in a collection. They stay in any collections they are already in.",
			inputSchema: { type: "object", properties: { keys, collection: key("The collection") }, required: ["keys", "collection"] },
			async handler(input) {
				return modify(zotero, input.keys, (data) => {
					const have = (data.collections as string[] | undefined) ?? [];
					return have.includes(input.collection) ? undefined : { collections: [...have, input.collection] };
				});
			},
		},
		{
			name: "create_collection",
			kind: "write",
			description: "Create a collection, at the top level or inside another one.",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string", minLength: 1, maxLength: 255 }, parent: key("The parent collection, to make a subcollection") },
				required: ["name"],
			},
			async handler(input) {
				const collection = { name: input.name, parentCollection: input.parent ?? false };
				return outcome(await zotero.send("POST", "/collections", [collection], { "Zotero-Write-Token": writeToken() }));
			},
		},
		{
			name: "restore_item",
			kind: "write",
			description: "Take an item out of Zotero's trash.",
			inputSchema: { type: "object", properties: { key: key("The item") }, required: ["key"] },
			async handler(input) {
				const item = await fetchItem(zotero, input.key);
				await zotero.send("PATCH", `/items/${input.key}`, { deleted: 0 }, { "If-Unmodified-Since-Version": String(item.version) });
				return text({ restored: input.key, title: item.data.title });
			},
		},
		{
			name: "update_item",
			kind: "destructive",
			description:
				"DESTRUCTIVE: overwrites the values of an item's fields (title, date, abstract, DOI and so on) and, if given, replaces its whole list of creators. The old values are not kept. Tags, collections and trashing have their own tools.",
			inputSchema: {
				type: "object",
				properties: { key: key("The item"), fields: fieldsSchema, creators: creatorsSchema },
				required: ["key"],
			},
			async handler(input) {
				const item = await fetchItem(zotero, input.key);
				try {
					await checkFields(zotero, item.data.itemType, input.fields);
				} catch (error) {
					return failure((error as Error).message);
				}
				const patch = { ...input.fields, ...(input.creators ? { creators: input.creators } : {}) };
				if (Object.keys(patch).length === 0) {
					return failure("Nothing to change: give fields or creators.");
				}
				await zotero.send("PATCH", `/items/${input.key}`, patch, { "If-Unmodified-Since-Version": String(item.version) });
				return text({ updated: input.key, changed: Object.keys(patch) });
			},
		},
		{
			name: "update_note",
			kind: "destructive",
			description: "DESTRUCTIVE: replaces the whole text of a note with new plain text. The old text is not kept.",
			inputSchema: {
				type: "object",
				properties: { key: key("The note"), note: { type: "string", minLength: 1, maxLength: 50000 } },
				required: ["key", "note"],
			},
			async handler(input) {
				const item = await fetchItem(zotero, input.key);
				if (item.data.itemType !== "note") {
					return failure(`${input.key} is a ${item.data.itemType}, not a note. Use update_item for that.`);
				}
				await zotero.send("PATCH", `/items/${input.key}`, { note: textToNoteHtml(input.note) }, { "If-Unmodified-Since-Version": String(item.version) });
				return text({ updated: input.key });
			},
		},
		{
			name: "remove_tags",
			kind: "destructive",
			description: "DESTRUCTIVE: removes tags from up to 50 items. The tags stay in the library and on other items.",
			inputSchema: { type: "object", properties: { keys, tags: tagList }, required: ["keys", "tags"] },
			async handler(input) {
				const unwanted = new Set(input.tags as string[]);
				return modify(zotero, input.keys, (data) => {
					const kept = (data.tags ?? []).filter((t) => !unwanted.has(t.tag));
					return kept.length === (data.tags ?? []).length ? undefined : { tags: kept };
				});
			},
		},
		{
			name: "remove_from_collection",
			kind: "destructive",
			description: "DESTRUCTIVE: takes up to 50 items out of a collection. The items stay in the library and in their other collections.",
			inputSchema: { type: "object", properties: { keys, collection: key("The collection") }, required: ["keys", "collection"] },
			async handler(input) {
				return modify(zotero, input.keys, (data) => {
					const have = (data.collections as string[] | undefined) ?? [];
					return have.includes(input.collection) ? { collections: have.filter((c) => c !== input.collection) } : undefined;
				});
			},
		},
		{
			name: "update_collection",
			kind: "destructive",
			description:
				"DESTRUCTIVE: renames a collection, moves it under another one, or moves it to the top level (parent null). Items are not affected.",
			inputSchema: {
				type: "object",
				properties: {
					key: key("The collection"),
					name: { type: "string", minLength: 1, maxLength: 255 },
					parent: { anyOf: [key("The new parent collection"), { type: "null" }], description: "A collection key, or null for the top level." },
				},
				required: ["key"],
			},
			async handler(input) {
				const patch: Record<string, unknown> = {};
				if (input.name !== undefined) {
					patch.name = input.name;
				}
				if (input.parent !== undefined) {
					patch.parentCollection = input.parent ?? false;
				}
				if (Object.keys(patch).length === 0) {
					return failure("Nothing to change: give a name or a parent.");
				}
				const current = parseJson<{ version: number }>(await zotero.get(`/collections/${input.key}`, { format: "json" }));
				await zotero.send("PATCH", `/collections/${input.key}`, patch, { "If-Unmodified-Since-Version": String(current.version) });
				return text({ updated: input.key, changed: Object.keys(patch) });
			},
		},
		{
			name: "trash_item",
			kind: "destructive",
			description:
				"DESTRUCTIVE: moves one item to Zotero's trash. It can be brought back with restore_item or from the trash in Zotero, but Zotero empties the trash after a while. Works on one item at a time, and nothing here deletes anything permanently.",
			inputSchema: { type: "object", properties: { key: key("The item") }, required: ["key"] },
			async handler(input) {
				const item = await fetchItem(zotero, input.key);
				await zotero.send("PATCH", `/items/${input.key}`, { deleted: 1 }, { "If-Unmodified-Since-Version": String(item.version) });
				return text({ trashed: input.key, title: item.data.title });
			},
		},
		{
			name: "delete_collection",
			kind: "destructive",
			description:
				"DESTRUCTIVE: deletes one collection and any subcollections inside it. The items in them stay in the library. This does not go to the trash, so check the collection with list_collections first.",
			inputSchema: { type: "object", properties: { key: key("The collection") }, required: ["key"] },
			async handler(input) {
				const current = slim(parseJson<{ version: number; data: { name: string } }>(await zotero.get(`/collections/${input.key}`, { format: "json" })));
				await zotero.send("DELETE", `/collections/${input.key}`, undefined, { "If-Unmodified-Since-Version": String(current.version) });
				return text({ deleted: input.key, name: current.data.name });
			},
		},
	];
}
