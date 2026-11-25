import type { ZoteroItem } from "./zotero";

/** Full text beyond this is cut. A few very long books would otherwise eat the free ingestion allowance on their own. */
export const MAX_FULLTEXT_CHARS = 400_000;

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

const REFERENCES_HEADING = /\n[ \t]*#{0,4}[ \t]*(references|reference list|bibliography|literature cited|works cited)[ \t]*:?[ \t]*\n/gi;

/**
 * What a citation looks like and body text does not: a DOI, or the volume(issue):pages and year;volume run of a journal
 * reference. A page of ordinary prose has none of these, and a reference list has several in every few lines.
 */
const CITATION_MARKER = new RegExp(
	[
		"doi:",
		"doi\\.org",
		"\\b10\\.\\d{4,9}/",
		// Vancouver: 2015;46 (2):193-205 and 46(2):193
		"\\b(?:19|20)\\d{2};\\s?\\d+\\s?[(:]",
		"\\b\\d+\\s?\\(\\d+\\):\\s?\\d+",
		// APA: "Smith, J. (2015). Title", and "Journal, 46(2), 193-205"
		"\\((?:19|20)\\d{2}\\)\\.\\s+[A-Z]",
		"\\b\\d{1,4}\\s?\\(\\d{1,3}\\),\\s?[a-z]?\\d+",
	].join("|"),
	"gi",
);
const WINDOW = 1500;
const DENSE = 4;
const OMITTED = "\n[reference list omitted]\n";

const countMarkers = (text: string) => (text.match(CITATION_MARKER) ?? []).length;

/** True for a passage that is mostly citations, which matches almost any query about its topic without saying anything. */
export function looksLikeReferences(text: string) {
	const markers = countMarkers(text);
	return markers >= 3 && markers / Math.max(1, text.length / WINDOW) >= DENSE;
}

/** Windows of about 1,500 characters, each ending at a line break so that no citation is cut in half. */
function windows(text: string) {
	const out: { start: number; end: number }[] = [];
	for (let start = 0; start < text.length; ) {
		let end = Math.min(start + WINDOW, text.length);
		const lineEnd = text.indexOf("\n", end);
		end = lineEnd !== -1 && lineEnd - end < 300 ? lineEnd + 1 : end;
		out.push({ start, end });
		start = end;
	}
	return out;
}

/**
 * Removes runs of two or more consecutive citation-dense windows, wherever they are (a paper's appendices often list references
 * of included studies). A cut starts at the line of the run's first citation and ends at the line of its last, so ordinary text
 * that shares a window with the edge of a list is kept.
 */
function stripCitationRuns(text: string) {
	const spans = windows(text).map(({ start, end }) => {
		const found = [...text.slice(start, end).matchAll(CITATION_MARKER)].map((match) => start + (match.index ?? 0));
		return { start, end, first: found[0], last: found.at(-1), dense: found.length >= DENSE };
	});

	let out = "";
	let at = 0;
	for (let i = 0; i < spans.length; i++) {
		const span = spans[i] as (typeof spans)[number];
		if (!span.dense || (!spans[i - 1]?.dense && !spans[i + 1]?.dense) || spans[i - 1]?.dense) {
			continue;
		}
		let last = i;
		while (spans[last + 1]?.dense) {
			last++;
		}
		const from = text.lastIndexOf("\n", span.first as number) + 1;
		const lineEnd = text.indexOf("\n", (spans[last] as (typeof spans)[number]).last as number);
		const to = lineEnd === -1 ? text.length : lineEnd + 1;
		out += text.slice(at, from) + OMITTED;
		at = to;
		i = last;
	}
	return out + text.slice(at);
}

/**
 * Removes a paper's reference lists before indexing. A page of citations matches almost any query on the paper's topic, so
 * left in it crowds real passages out of search results, and it is a large share of what is indexed and paid for. Two passes:
 * everything after a "References" heading in the back half, then any run of citation-dense text elsewhere. If that would
 * leave almost nothing, the text is kept as it was.
 */
export function stripReferences(text: string) {
	let cut = -1;
	for (const match of text.matchAll(REFERENCES_HEADING)) {
		if (match.index !== undefined && match.index > text.length * 0.5) {
			cut = match.index;
		}
	}
	const beforeHeading = cut > 2000 ? text.slice(0, cut).trimEnd() : text;
	const stripped = stripCitationRuns(beforeHeading);
	return stripped.replaceAll(OMITTED, "").trim().length >= 2000 ? stripped : beforeHeading;
}

export type IndexMetadata = { title: string; year: string; itemtype: string; doi: string; creators: string };

/** The five custom metadata fields an AI Search instance allows, in the order the instance declares them. */
export const METADATA_FIELDS = ["title", "year", "itemtype", "doi", "creators"] as const;

/**
 * The text indexed for one paper: its title, authors, year, abstract and the full text of its attachments. Tags and notes are
 * left out on purpose, so that editing them never changes what is indexed and so never costs a re-ingest.
 */
export function buildDocument(parent: ZoteroItem, fullTexts: string[]) {
	const { data } = parent;
	const title = data.title ?? "(untitled)";
	const authors = (data.creators ?? []).filter((c) => !c.creatorType || c.creatorType === "author").map(creatorName).filter(Boolean);

	const header = [
		`# ${title}`,
		authors.length > 0 ? `Authors: ${authors.join("; ")}` : "",
		[yearOf(parent) && `Year: ${yearOf(parent)}`, data.publicationTitle && `Published in: ${data.publicationTitle}`, data.DOI && `DOI: ${data.DOI}`, `Type: ${data.itemType}`]
			.filter(Boolean)
			.join(" · "),
		`Zotero key: ${parent.key}`,
	].filter(Boolean);

	const sections = [header.join("\n")];
	if (data.abstractNote) {
		sections.push(`## Abstract\n${data.abstractNote}`);
	}
	const fullText = fullTexts.map(stripReferences).join("\n\n").slice(0, MAX_FULLTEXT_CHARS);
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
