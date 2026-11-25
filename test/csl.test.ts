import { describe, expect, it } from "vitest";
import { cslToItem, normalizeDoi, zoteroTypeOf } from "../src/csl";

const journal = { itemType: "journalArticle", title: "", creators: [], abstractNote: "", publicationTitle: "", volume: "", issue: "", pages: "", date: "", DOI: "", url: "", language: "", ISSN: "", extra: "" };
const book = { itemType: "book", title: "", creators: [], publisher: "", place: "", date: "", ISBN: "", extra: "" };
const preprint = { itemType: "preprint", title: "", creators: [], abstractNote: "", date: "", DOI: "", url: "", repository: "", extra: "" };

describe("normalizeDoi", () => {
	it("accepts the common forms", () => {
		for (const form of ["10.1000/abc.123", "doi:10.1000/abc.123", "DOI: 10.1000/abc.123", "https://doi.org/10.1000/abc.123", "http://dx.doi.org/10.1000/abc.123", "  10.1000/abc.123 "]) {
			expect(normalizeDoi(form)).toBe("10.1000/abc.123");
		}
	});

	it("rejects anything else, including other hosts", () => {
		for (const bad of ["", "abc", "https://evil.example/10.1000/x", "10.1/x", "https://doi.org/", "10.1000/has space"]) {
			expect(() => normalizeDoi(bad)).toThrow("not a DOI");
		}
	});
});

describe("cslToItem", () => {
	it("maps a journal article", () => {
		const item = cslToItem(
			{ type: "article-journal", title: "T", author: [{ given: "Ada", family: "Lovelace" }, { literal: "The Consortium" }], "container-title": "Nature", volume: "5", issue: 2, page: "10-20", DOI: "10.1/x", URL: "https://doi.org/10.1/x", ISSN: ["1234-5678", "9999-9999"], issued: { "date-parts": [[2021, 3, 4]] }, abstract: "<jats:p>An <jats:italic>abstract</jats:italic> &amp; more.</jats:p>", language: "en" },
			journal,
		);
		expect(item).toEqual({
			itemType: "journalArticle", title: "T", abstractNote: "An abstract & more.", date: "2021-03-04", DOI: "10.1/x", url: "https://doi.org/10.1/x", language: "en",
			publicationTitle: "Nature", volume: "5", issue: "2", pages: "10-20", ISSN: "1234-5678",
			creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }, { creatorType: "author", name: "The Consortium" }],
		});
	});

	it("only sets fields the type has, and keeps a DOI or ISBN it cannot place in Extra", () => {
		const item = cslToItem({ type: "book", title: "B", publisher: "Pub", "publisher-place": "London", ISBN: ["978-0", "0-12"], DOI: "10.1/b", "container-title": "Ignored", issued: { "date-parts": [[1999]] } }, book);
		expect(item).toMatchObject({ itemType: "book", publisher: "Pub", place: "London", ISBN: "978-0 0-12", date: "1999", extra: "DOI: 10.1/b" });
		expect(item).not.toHaveProperty("DOI");
		expect(item).not.toHaveProperty("publicationTitle");
	});

	it("treats arXiv-style records as preprints, with the publisher as the repository", () => {
		expect(zoteroTypeOf({ type: "article" })).toBe("preprint");
		const item = cslToItem({ type: "article", title: "P", publisher: "arXiv", DOI: "10.48550/arXiv.1", issued: { "date-parts": [[2024, 1]] } }, preprint);
		expect(item).toMatchObject({ itemType: "preprint", repository: "arXiv", DOI: "10.48550/arXiv.1", date: "2024-01" });
	});

	it("uses editors only where the type has them, and drops nameless creators and empty dates", () => {
		const item = cslToItem({ type: "article", editor: [{ given: "E", family: "Ditor" }], author: [{}], issued: { "date-parts": [[null]] } }, preprint);
		expect(item.creators).toEqual([{ creatorType: "contributor", firstName: "E", lastName: "Ditor" }]);
		expect(item).not.toHaveProperty("date");
		expect(zoteroTypeOf({})).toBe("journalArticle");
	});
});
