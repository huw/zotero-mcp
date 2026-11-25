import { env } from "cloudflare:workers";
import { type IndexMetadata, METADATA_FIELDS } from "./document";

/** The Zotero item key is the file name, so a search hit points straight back at its item. */
export const fileName = (key: string) => `${key}.md`;
export const keyOf = (fileName: string) => fileName.replace(/\.md$/, "");

/** What the sync needs from the search index. The AI Search implementation is below; tests fake it. */
export interface SearchIndex {
	/** Creates the index if it does not exist yet. */
	ensure(): Promise<void>;
	/** Adds or replaces one item. */
	upsert(key: string, text: string, metadata: IndexMetadata): Promise<void>;
	/** Removes one item. Removing something that is not there is fine. */
	remove(key: string): Promise<void>;
}

function instance() {
	return env.AI_SEARCH.get(env.AI_SEARCH_INSTANCE);
}

export function aiSearchIndex(): SearchIndex {
	return {
		async ensure() {
			try {
				await instance().info();
			} catch {
				// Built-in storage, hybrid retrieval, and the five metadata fields documents carry.
				await env.AI_SEARCH.create({
					id: env.AI_SEARCH_INSTANCE,
					index_method: { vector: true, keyword: true },
					custom_metadata: METADATA_FIELDS.map((field_name) => ({ field_name, data_type: "text" as const })),
				});
			}
		},
		async upsert(key, text, metadata) {
			// Uploading under an existing name overwrites and re-indexes it.
			// A field with nothing in it (an item with no date, say) is left out rather than sent empty.
			const present = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== ""));
			await instance().items.upload(fileName(key), text, { metadata: present });
		},
		async remove(key) {
			const { result } = await instance().items.list({ key: fileName(key), source: "builtin" });
			for (const item of result) {
				await instance().items.delete(item.id);
			}
		},
	};
}
