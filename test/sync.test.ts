import { describe, expect, it } from "vitest";
import { type SyncState, runSync } from "../src/sync";
import { FakeIndex, FakeZotero, item } from "./fakes";

function setup(budget?: number) {
	const zotero = new FakeZotero(budget);
	const index = new FakeIndex();
	let state: SyncState | null = null;
	const run = (z: FakeZotero = zotero) =>
		runSync({ zotero: z, index, load: async () => state, save: async (s) => void (state = structuredClone(s)) });
	return { zotero, index, run, state: () => state as SyncState };
}

function library(z: FakeZotero) {
	z.items = [
		item("AAAAAAAA", 5, { abstractNote: "About reefs.", date: "2021-03-04", DOI: "10.1/abc", tags: [{ tag: "coral" }], creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }] }, { creatorSummary: "Lovelace", parsedDate: "2021-03-04" }),
		item("PDFPDFPD", 5, { itemType: "attachment", parentItem: "AAAAAAAA", contentType: "application/pdf", linkMode: "imported_file" }),
		item("NOTENOTE", 6, { itemType: "note", parentItem: "AAAAAAAA", note: "<p>Key idea: <b>bleaching</b></p>" }),
		item("BBBBBBBB", 7, { title: "A book", itemType: "book" }),
	];
	z.fullText = { PDFPDFPD: { content: "Corals bleach when water warms.", version: 6 } };
}

describe("sync", () => {
	it("indexes top-level items with their full text and notes, and records where it got to", async () => {
		const t = setup();
		library(t.zotero);
		const result = await t.run();

		expect(result.error).toBeUndefined();
		expect([...t.index.docs.keys()].sort()).toEqual(["AAAAAAAA", "BBBBBBBB"]);
		const doc = t.index.docs.get("AAAAAAAA");
		expect(doc?.text).toContain("# Title AAAAAAAA");
		expect(doc?.text).toContain("Authors: Ada Lovelace");
		expect(doc?.text).toContain("About reefs.");
		expect(doc?.text).toContain("Key idea: bleaching");
		expect(doc?.text).toContain("Corals bleach when water warms.");
		expect(doc?.metadata).toMatchObject({ year: "2021", itemtype: "journalArticle", doi: "10.1/abc", creators: "Lovelace" });
		expect(t.state().queue).toEqual([]);
		expect(t.state().version).toBe(10);
		expect(t.state().ftVersion).toBe(6);
		expect(t.index.ensured).toBe(1);
	});

	it("does nothing when the library has not changed", async () => {
		const t = setup();
		library(t.zotero);
		await t.run();
		const before = t.zotero.calls.length;
		const again = await t.run();

		expect(again.indexed + again.removed).toBe(0);
		// One conditional request for items, one for full text.
		expect(t.zotero.calls.length - before).toBe(2);
	});

	it("reindexes an item when its attachment's text arrives after the item", async () => {
		const t = setup();
		library(t.zotero);
		delete t.zotero.fullText.PDFPDFPD;
		await t.run();
		expect(t.index.docs.get("AAAAAAAA")?.text).not.toContain("Corals bleach");

		t.zotero.fullText.PDFPDFPD = { content: "Corals bleach when water warms.", version: 11 };
		await t.run();
		expect(t.index.docs.get("AAAAAAAA")?.text).toContain("Corals bleach");
	});

	it("reindexes the parent when a note changes", async () => {
		const t = setup();
		library(t.zotero);
		await t.run();

		t.zotero.version = 12;
		const note = t.zotero.items.find((i) => i.key === "NOTENOTE");
		if (note) {
			note.version = 12;
			note.data.note = "<p>Changed my mind</p>";
		}
		await t.run();
		expect(t.index.docs.get("AAAAAAAA")?.text).toContain("Changed my mind");
	});

	it("removes trashed and permanently deleted items", async () => {
		const t = setup();
		library(t.zotero);
		await t.run();

		t.zotero.version = 13;
		const trashed = t.zotero.items.find((i) => i.key === "BBBBBBBB");
		if (trashed) {
			trashed.version = 13;
			trashed.data.deleted = 1;
		}
		await t.run();
		expect(t.index.docs.has("BBBBBBBB")).toBe(false);

		t.zotero.version = 14;
		t.zotero.items = t.zotero.items.filter((i) => i.data.parentItem !== "AAAAAAAA" && i.key !== "AAAAAAAA");
		t.zotero.deleted = ["AAAAAAAA"];
		await t.run();
		expect(t.index.docs.size).toBe(0);
	});

	it("stops at its request budget and carries on next run", async () => {
		const t = setup();
		t.zotero.items = Array.from({ length: 6 }, (_, i) => item(`ITEM000${i}`, 5 + i, { title: `Paper ${i}` }));
		const small = new FakeZotero(8);
		small.items = t.zotero.items;

		const first = await t.run(small);
		expect(first.error).toBeUndefined();
		expect(first.indexed).toBeGreaterThan(0);
		expect(first.indexed).toBeLessThan(6);
		expect(t.state().queue.length).toBe(6 - first.indexed);

		// A fresh budget finishes the queue without rereading the library.
		const rest = new FakeZotero();
		rest.items = t.zotero.items;
		await t.run(rest);
		expect(t.index.docs.size).toBe(6);
		expect(t.state().queue).toEqual([]);
	});

	it("keeps going where it left off when discovery runs out of budget partway", async () => {
		const t = setup();
		t.zotero.items = Array.from({ length: 150 }, (_, i) => item(`K${String(i).padStart(7, "0")}`, 5 + i));
		const tight = new FakeZotero(2);
		tight.items = t.zotero.items;
		await t.run(tight);
		expect(t.state().discover?.start).toBe(100);

		const rest = new FakeZotero();
		rest.items = t.zotero.items;
		await t.run(rest);
		expect(t.state().discover).toBeUndefined();
		expect(t.index.docs.size).toBe(150);
	});

	it("records an error and keeps its queue when something breaks", async () => {
		const t = setup();
		library(t.zotero);
		t.index.upsert = async () => {
			throw new Error("index down");
		};
		const result = await t.run();
		expect(result.error).toBe("index down");
		expect(t.state().queue.length).toBeGreaterThan(0);
		expect(t.state().lastRun?.error).toBe("index down");
	});
});
