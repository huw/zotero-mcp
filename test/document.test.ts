import { describe, expect, it } from "vitest";
import { stripReferences } from "../src/document";

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
