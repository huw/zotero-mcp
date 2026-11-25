import type { ZoteroItem } from "./zotero";

/** Full text beyond this is cut. A few very long books would otherwise eat the free ingestion allowance on their own. */
export const MAX_FULLTEXT_CHARS = 400_000;
const MAX_NOTES_CHARS = 20_000;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** Zotero returns notes and formatted bibliographies as HTML. */
export function htmlToText(html: string) {
	return html
		.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function creatorName(creator: NonNullable<ZoteroItem["data"]["creators"]>[number]) {
	return creator.name ?? [creator.firstName, creator.lastName].filter(Boolean).join(" ");
}

export function yearOf(item: ZoteroItem) {
	return (item.meta?.parsedDate ?? item.data.date ?? "").match(/\d{4}/)?.[0] ?? "";
}

/** Zotero's own summary ("Smith et al.") is the best short form. */
function creatorSummary(item: ZoteroItem) {
	return item.meta?.creatorSummary ?? "";
}

export type IndexMetadata = { title: string; year: string; itemtype: string; doi: string; creators: string };

/** The five custom metadata fields an AI Search instance allows, in the order the instance declares them. */
export const METADATA_FIELDS = ["title", "year", "itemtype", "doi", "creators"] as const;

export function buildDocument(parent: ZoteroItem, children: ZoteroItem[], fullTexts: string[]) {
	const { data } = parent;
	const title = data.title ?? "(untitled)";
	const authors = (data.creators ?? []).filter((c) => !c.creatorType || c.creatorType === "author").map(creatorName).filter(Boolean);
	const tags = (data.tags ?? []).map((t) => t.tag);

	const header = [
		`# ${title}`,
		authors.length > 0 ? `Authors: ${authors.join("; ")}` : "",
		[yearOf(parent) && `Year: ${yearOf(parent)}`, data.publicationTitle && `Published in: ${data.publicationTitle}`, data.DOI && `DOI: ${data.DOI}`, `Type: ${data.itemType}`]
			.filter(Boolean)
			.join(" · "),
		tags.length > 0 ? `Tags: ${tags.join(", ")}` : "",
		`Zotero key: ${parent.key}`,
	].filter(Boolean);

	const sections = [header.join("\n")];
	if (data.abstractNote) {
		sections.push(`## Abstract\n${data.abstractNote}`);
	}
	const notes = children
		.filter((child) => child.data.itemType === "note" && child.data.note)
		.map((child) => htmlToText(child.data.note ?? ""))
		.join("\n\n")
		.slice(0, MAX_NOTES_CHARS);
	if (notes) {
		sections.push(`## My notes\n${notes}`);
	}
	const fullText = fullTexts.join("\n\n").slice(0, MAX_FULLTEXT_CHARS);
	if (fullText) {
		sections.push(`## Full text\n${fullText}`);
	}

	const metadata: IndexMetadata = {
		title: title.slice(0, 200),
		year: yearOf(parent),
		itemtype: data.itemType,
		doi: data.DOI ?? "",
		creators: creatorSummary(parent),
	};
	return { text: sections.join("\n\n"), metadata };
}
