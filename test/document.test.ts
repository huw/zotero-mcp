import { describe, expect, it } from "vitest";
import { looksLikeReferences, stripReferences } from "../src/document";

const body = "Introduction. ".repeat(400);

describe("stripReferences", () => {
	it("cuts the reference list that follows the body", () => {
		const text = `${body}\n\nConclusion text.\n\nReferences\n1. Smith J. A paper. 2001. doi:10.1/x\n2. Jones K. Another. 2002.`;
		const out = stripReferences(text);
		expect(out).toContain("Conclusion text.");
		expect(out).not.toContain("Smith J.");
		expect(out).not.toMatch(/References\s*$/);
	});

	it("recognises markdown headings and other names for the section", () => {
		for (const heading of ["## References", "REFERENCES", "Bibliography", "Literature Cited", "References:"]) {
			expect(stripReferences(`${body}\n${heading}\n1. Smith J.`)).not.toContain("Smith J.");
		}
	});

	it("keeps text when the heading is early (a mention in the body) or the body would be tiny", () => {
		const early = `Intro\nReferences\n${"x ".repeat(5000)}`;
		expect(stripReferences(early)).toBe(early);
		const short = "Short.\nReferences\n1. Smith";
		expect(stripReferences(short)).toBe(short);
	});

	it("cuts at the last such heading, so a References heading in a section title does not end the paper early", () => {
		const text = `${body}\nReferences\nsee the discussion.\n${body}\n${body}\nReferences\n1. Smith J.`;
		const out = stripReferences(text);
		expect(out).toContain("see the discussion.");
		expect(out).not.toContain("Smith J.");
	});

	it("leaves text without a reference section alone", () => {
		expect(stripReferences(body)).toBe(body);
	});
});

const citations = (n: number) =>
	Array.from({ length: n }, (_, i) => `${i + 1}. Author${i} A, Other B. A study of things number ${i}. J Some Med. ${2000 + (i % 20)};${10 + i}(${(i % 4) + 1}):${100 + i}-${110 + i}. doi:10.1000/x${i}\n`).join("");

describe("stripReferences, with no References heading", () => {
	it("removes a reference list in the middle of the text, such as an appendix of included studies, and keeps what surrounds it", () => {
		const text = `${body}\nThe main conclusions of the review.\n\nAppendix: studies\n${citations(60)}\nAppendix B. Search strategy\n${"Searched databases. ".repeat(200)}`;
		const out = stripReferences(text);
		expect(out).toContain("The main conclusions of the review.");
		expect(out).toContain("Search strategy");
		expect(out).toContain("[reference list omitted]");
		expect(out).not.toContain("Author30 A");
		expect(text.length - out.length).toBeGreaterThan(5000);
	});

	it("leaves ordinary prose, and a single citation-heavy paragraph, alone", () => {
		expect(stripReferences(body)).toBe(body);
		const one = `${body}\n${citations(3)}\n${body}`;
		expect(stripReferences(one)).toContain("Author2 A");
	});

	it("keeps the text when stripping would leave almost nothing", () => {
		const all = citations(80);
		expect(stripReferences(all)).toBe(all);
	});
});

describe("looksLikeReferences", () => {
	it("is true of a list of citations and false of prose, however much it cites by name", () => {
		expect(looksLikeReferences(citations(12))).toBe(true);
		expect(looksLikeReferences("Smith et al. (2019) found that corals bleach, consistent with Jones and Lee (2017). ".repeat(20))).toBe(false);
		expect(looksLikeReferences(body)).toBe(false);
		expect(looksLikeReferences("See doi:10.1000/x for details.")).toBe(false);
	});
});
