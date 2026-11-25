import { htmlToText } from "./document";

/** The parts of CSL JSON, which Crossref and DataCite both return for a DOI, that become Zotero fields. */
export type Csl = {
	type?: string;
	title?: string;
	author?: Person[];
	editor?: Person[];
	"container-title"?: string | string[];
	"container-title-short"?: string | string[];
	volume?: string | number;
	issue?: string | number;
	page?: string;
	DOI?: string;
	URL?: string;
	ISSN?: string | string[];
	ISBN?: string | string[];
	publisher?: string;
	"publisher-place"?: string;
	abstract?: string;
	issued?: { "date-parts"?: (number | string | null)[][]; raw?: string; literal?: string };
	language?: string;
	edition?: string | number;
	number?: string;
	genre?: string;
};
type Person = { family?: string; given?: string; literal?: string; name?: string };

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

/** Accepts a bare DOI, `doi:10...`, or a doi.org link. */
export function normalizeDoi(input: string) {
	const doi = input
		.trim()
		.replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "")
		.trim();
	if (!DOI_PATTERN.test(doi)) {
		throw new Error(`"${input}" is not a DOI. A DOI looks like 10.1000/xyz123.`);
	}
	return doi;
}

/** Asks doi.org for a DOI's metadata. It is the only place this Worker fetches from other than Zotero, and the address is built from a checked DOI. */
export async function resolveDoi(doi: string): Promise<Csl> {
	const response = await fetch(`https://doi.org/${encodeURI(doi)}`, { headers: { Accept: "application/vnd.citationstyles.csl+json" } });
	if (response.status === 404) {
		throw new Error(`doi.org does not know the DOI ${doi}. Check it for typos.`);
	}
	if (!response.ok) {
		throw new Error(`doi.org returned HTTP ${response.status} for ${doi}.`);
	}
	return (await response.json()) as Csl;
}

const ITEM_TYPES: Record<string, string> = {
	"article-journal": "journalArticle",
	"paper-conference": "conferencePaper",
	book: "book",
	chapter: "bookSection",
	report: "report",
	thesis: "thesis",
	article: "preprint",
	"article-newspaper": "newspaperArticle",
	"article-magazine": "magazineArticle",
	dataset: "dataset",
	webpage: "webpage",
};

export const zoteroTypeOf = (csl: Csl) => ITEM_TYPES[csl.type ?? ""] ?? "journalArticle";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function dateOf(csl: Csl) {
	const parts = csl.issued?.["date-parts"]?.[0]?.filter((part) => part !== null && part !== undefined) ?? [];
	if (parts.length === 0) {
		return csl.issued?.raw ?? csl.issued?.literal ?? "";
	}
	return parts.map((part, i) => (i === 0 ? String(part) : String(part).padStart(2, "0"))).join("-");
}

const EDITOR_TYPES = new Set(["journalArticle", "conferencePaper", "book", "bookSection"]);

function creatorsOf(csl: Csl, itemType: string) {
	const person = (p: Person, creatorType: string) =>
		p.family ? { creatorType, firstName: p.given ?? "", lastName: p.family } : { creatorType, name: p.literal ?? p.name ?? p.given ?? "" };
	return [
		...(csl.author ?? []).map((p) => person(p, "author")),
		...(csl.editor ?? []).map((p) => person(p, EDITOR_TYPES.has(itemType) ? "editor" : "contributor")),
	].filter((c) => ("name" in c ? c.name : c.lastName));
}

/**
 * Builds a Zotero item from a DOI's CSL record. Only fields the item type allows are set, taken from Zotero's own template
 * for that type. A DOI or ISBN the type has no field for goes in Extra, the way Zotero itself stores it.
 */
export function cslToItem(csl: Csl, template: Record<string, unknown>) {
	const itemType = zoteroTypeOf(csl);
	const item: Record<string, unknown> = { itemType };
	const extra: string[] = [];

	const set = (value: unknown, ...fields: string[]) => {
		const text = value === undefined || value === null ? "" : String(value).trim();
		if (!text) {
			return false;
		}
		const field = fields.find((candidate) => candidate in template);
		if (field) {
			item[field] = text;
		}
		return field !== undefined;
	};

	set(csl.title, "title");
	set(csl.abstract ? htmlToText(csl.abstract) : "", "abstractNote");
	set(dateOf(csl), "date");
	if (!set(csl.DOI, "DOI") && csl.DOI) {
		extra.push(`DOI: ${csl.DOI}`);
	}
	set(csl.URL, "url");
	set(csl.language, "language");
	set(first(csl["container-title"]), "publicationTitle", "proceedingsTitle", "bookTitle", "websiteTitle");
	set(first(csl["container-title-short"]), "journalAbbreviation");
	set(csl.volume, "volume");
	set(csl.issue, "issue");
	set(csl.page, "pages");
	set(first(csl.ISSN), "ISSN");
	const isbn = Array.isArray(csl.ISBN) ? csl.ISBN.join(" ") : csl.ISBN;
	if (!set(isbn, "ISBN") && isbn) {
		extra.push(`ISBN: ${isbn}`);
	}
	set(csl.publisher, "publisher", "repository", "institution", "university");
	set(csl["publisher-place"], "place");
	set(csl.edition, "edition");
	set(csl.number, "reportNumber");
	set(csl.genre, "thesisType");

	const creators = creatorsOf(csl, itemType);
	if (creators.length > 0) {
		item.creators = creators;
	}
	if (extra.length > 0 && "extra" in template) {
		item.extra = extra.join("\n");
	}
	return item;
}
