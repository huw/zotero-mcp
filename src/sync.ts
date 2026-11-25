import { buildDocument } from "./document";
import type { SearchIndex } from "./search-index";
import { BudgetExhausted, parseJson, ZoteroError, type ZoteroItem, type ZoteroLike } from "./zotero";

/**
 * Where the sync has got to. It is small, and lives in KV.
 *
 * `version` and `ftVersion` are Zotero's library and full-text versions already taken in. `discover` marks a paged read of
 * changes in progress. `queue` holds the Zotero keys of top-level items still to index or remove: a key that no longer
 * exists in Zotero, or is in the trash, is removed from the index.
 */
export type SyncState = {
	version: number;
	ftVersion: number;
	discover?: { start: number; version: number };
	queue: string[];
	lastRun?: { at: string; indexed: number; removed: number; error?: string };
};

export const EMPTY_STATE: SyncState = { version: 0, ftVersion: 0, queue: [] };

const PAGE = 100;
const BATCH = 25;
/** A parent costs its children, plus one full-text request per attachment. Stop starting new ones when less than this is left. */
const ITEM_COST = 4;
const TEXT_TYPES = /^(application\/pdf|application\/epub\+zip|text\/)/;
const CHILD_TYPES = new Set(["attachment", "note", "annotation"]);

export type SyncDeps = {
	zotero: ZoteroLike;
	index: SearchIndex;
	load(): Promise<SyncState | null>;
	save(state: SyncState): Promise<void>;
	now?: () => Date;
};

function addUnique(queue: string[], keys: Iterable<string>) {
	const seen = new Set(queue);
	for (const key of keys) {
		if (!seen.has(key)) {
			seen.add(key);
			queue.push(key);
		}
	}
}

/** Fetches the items changed since the last sync, a page at a time, and queues the top-level items they affect. */
async function discover(state: SyncState, { zotero }: SyncDeps) {
	const first = !state.discover;
	// A first page that says "not modified" means nothing in the library changed since `state.version`.
	const conditional: Record<string, string> = first && state.version > 0 ? { "If-Modified-Since-Version": String(state.version) } : {};

	while (true) {
		const start = state.discover?.start ?? 0;
		const page = await zotero.get(
			"/items",
			{ since: state.version, includeTrashed: 1, format: "json", limit: PAGE, start, sort: "dateModified", direction: "asc" },
			start === 0 ? conditional : {},
		);
		if (page.status === 304) {
			return;
		}
		state.discover ??= { start: 0, version: page.version ?? state.version };
		const items = parseJson<ZoteroItem[]>(page);
		// A changed attachment or note means its parent's document is stale; a changed top-level item is its own.
		addUnique(
			state.queue,
			items.flatMap((item) => {
				const key = item.data.parentItem ?? (CHILD_TYPES.has(item.data.itemType) ? undefined : item.key);
				return key ? [key] : [];
			}),
		);
		state.discover.start = start + items.length;
		const done = page.total === undefined ? items.length < PAGE : state.discover.start >= page.total;
		if (items.length === 0 || done) {
			break;
		}
		if (!zotero.hasBudget(2)) {
			return; // Pick up from `state.discover.start` on the next run.
		}
	}

	// Items deleted for good are gone from /items, so they only show up here.
	if (state.version > 0) {
		const deleted = parseJson<{ items?: string[] }>(await zotero.get("/deleted", { since: state.version }));
		addUnique(state.queue, deleted.items ?? []);
	}
	state.version = state.discover.version;
	state.discover = undefined;
}

/** Zotero extracts full text on the desktop and uploads it after the item itself, so a new PDF's text arrives later than the item. */
async function discoverFullText(state: SyncState, { zotero }: SyncDeps) {
	const changed = parseJson<Record<string, number>>(await zotero.get("/fulltext", { since: state.ftVersion }));
	const attachments = Object.keys(changed);
	const latest = Math.max(state.ftVersion, ...Object.values(changed));
	// The first sync queues every item anyway, and attachment lookups for all of them would be a waste.
	if (state.version > 0 && attachments.length > 0) {
		for (let i = 0; i < attachments.length; i += 50) {
			const batch = attachments.slice(i, i + 50);
			const items = parseJson<ZoteroItem[]>(
				await zotero.get("/items", { itemKey: batch.join(","), includeTrashed: 1, format: "json", limit: 50 }),
			);
			addUnique(state.queue, items.flatMap((item) => (item.data.parentItem ? [item.data.parentItem] : [])));
		}
	}
	state.ftVersion = latest;
}

async function fullTextOf(zotero: ZoteroLike, attachment: ZoteroItem) {
	try {
		return parseJson<{ content?: string }>(await zotero.get(`/items/${attachment.key}/fulltext`)).content ?? "";
	} catch (error) {
		// Zotero answers 404 for an attachment it has no text for (never indexed, or an image).
		if (error instanceof ZoteroError && error.status === 404) {
			return "";
		}
		throw error;
	}
}

async function indexOne(parent: ZoteroItem, { zotero, index }: SyncDeps) {
	const children = parseJson<ZoteroItem[]>(await zotero.get(`/items/${parent.key}/children`, { format: "json", limit: 100 }));
	const texts: string[] = [];
	for (const child of children) {
		if (child.data.itemType === "attachment" && child.data.linkMode !== "linked_url" && TEXT_TYPES.test(child.data.contentType ?? "")) {
			const text = await fullTextOf(zotero, child);
			if (text) {
				texts.push(text);
			}
		}
	}
	const { text, metadata } = buildDocument(parent, children, texts);
	await index.upsert(parent.key, text, metadata);
}

/** One scheduled run: find what changed, then index or remove as many of the queued items as this invocation's request budget allows. */
export async function runSync(deps: SyncDeps) {
	const { zotero, index } = deps;
	const state = (await deps.load()) ?? structuredClone(EMPTY_STATE);
	let indexed = 0;
	let removed = 0;
	let error: string | undefined;

	try {
		await index.ensure();
		if (state.queue.length === 0 || state.discover) {
			await discover(state, deps);
			if (!state.discover) {
				await discoverFullText(state, deps);
			}
		}

		while (state.queue.length > 0 && zotero.hasBudget(ITEM_COST)) {
			const batch = state.queue.slice(0, BATCH);
			const found = new Map(
				parseJson<ZoteroItem[]>(
					await zotero.get("/items", { itemKey: batch.join(","), includeTrashed: 1, format: "json", limit: BATCH }),
				).map((item) => [item.key, item]),
			);
			for (const key of batch) {
				if (!zotero.hasBudget(ITEM_COST)) {
					break;
				}
				const parent = found.get(key);
				if (!parent || parent.data.deleted || CHILD_TYPES.has(parent.data.itemType)) {
					await index.remove(key);
					removed++;
				} else {
					await indexOne(parent, deps);
					indexed++;
				}
				state.queue.shift();
			}
		}
	} catch (caught) {
		if (!(caught instanceof BudgetExhausted)) {
			error = caught instanceof Error ? caught.message : String(caught);
			console.error("Zotero sync failed", { error });
		}
	}

	state.lastRun = {
		at: (deps.now?.() ?? new Date()).toISOString(),
		indexed,
		removed,
		...(error ? { error } : {}),
	};
	await deps.save(state);
	return { state, indexed, removed, error };
}
