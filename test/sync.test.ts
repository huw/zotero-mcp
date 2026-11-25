import { describe, expect, it } from "vitest";
import { DOCUMENT_FORMAT, EMPTY_STATE, type SyncState, runSync } from "../src/sync";
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
	it("indexes top-level items with their full text, and records where it got to", async () => {
		const t = setup();
		library(t.zotero);
		const result = await t.run();

		expect(result.error).toBeUndefined();
		expect([...t.index.docs.keys()].sort()).toEqual(["AAAAAAAA", "BBBBBBBB"]);
		const doc = t.index.docs.get("AAAAAAAA");
		expect(doc?.text).toContain("# Title AAAAAAAA");
		expect(doc?.text).toContain("Authors: Ada Lovelace");
		expect(doc?.text).toContain("About reefs.");
		// Tags and notes are deliberately not part of the indexed text.
		expect(doc?.text).not.toContain("bleaching");
		expect(doc?.text).not.toContain("Tags:");
		expect(doc?.text).not.toContain("My notes");
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

	it("does not upload again when only a note or a tag changes", async () => {
		const t = setup();
		library(t.zotero);
		await t.run();
		const uploadsBefore = t.index.upserts;

		t.zotero.version = 12;
		const note = t.zotero.items.find((i) => i.key === "NOTENOTE");
		const parent = t.zotero.items.find((i) => i.key === "AAAAAAAA");
		if (note && parent) {
			note.version = 12;
			note.data.note = "<p>Changed my mind</p>";
			parent.version = 12;
			parent.data.tags = [{ tag: "new-tag" }];
		}
		const result = await t.run();

		expect(t.index.upserts).toBe(uploadsBefore);
		expect(result.indexed).toBe(0);
		expect(result.unchanged).toBe(1);
		expect(t.state().lastRun).toMatchObject({ indexed: 0, unchanged: 1 });
		expect(t.index.docs.get("AAAAAAAA")?.text).not.toContain("Changed my mind");
	});

	it("does upload again when the paper's text changes: a new PDF, or a corrected abstract", async () => {
		const t = setup();
		library(t.zotero);
		await t.run();
		const before = t.index.upserts;

		t.zotero.version = 12;
		const parent = t.zotero.items.find((i) => i.key === "AAAAAAAA");
		if (parent) {
			parent.version = 12;
			parent.data.abstractNote = "A corrected abstract.";
		}
		await t.run();
		expect(t.index.upserts).toBe(before + 1);
		expect(t.index.docs.get("AAAAAAAA")?.text).toContain("A corrected abstract.");

		t.zotero.version = 13;
		t.zotero.fullText.PDFPDFPD = { content: "Different extracted text.", version: 13 };
		await t.run();
		expect(t.index.upserts).toBe(before + 2);
		expect(t.index.docs.get("AAAAAAAA")?.text).toContain("Different extracted text.");
	});

	it("adopts the previous layout without uploading anything, then uploads real changes", async () => {
		const t = setup();
		library(t.zotero);
		// A library already indexed under the previous layout, whose documents also held tags and notes.
		for (const key of ["AAAAAAAA", "BBBBBBBB"]) {
			await t.index.upsert(key, "old document with tags and notes", { title: "", year: "", itemtype: "", doi: "", creators: "" });
		}
		const before = t.index.upserts;
		const migrating = () =>
			runSync({ zotero: t.zotero, index: t.index, load: async () => state, save: async (s) => void (state = structuredClone(s)) });
		let state: SyncState | null = { format: 4, version: 10, ftVersion: 6, queue: [] };

		const first = await migrating();
		expect(first.indexed).toBe(0);
		expect(t.index.upserts).toBe(before); // nothing re-ingested
		expect(Object.keys(state?.hashes ?? {}).sort()).toEqual(["AAAAAAAA", "BBBBBBBB"]);
		expect(state?.format).toBe(DOCUMENT_FORMAT);
		expect(state?.adopt).toBeUndefined();

		// Once adoption is over, a paper with no fingerprint is new and is uploaded.
		t.zotero.version = 20;
		t.zotero.items.push(item("CCCCCCCC", 20, { title: "A new paper" }));
		const second = await migrating();
		expect(second.indexed).toBe(1);
		expect(t.index.docs.has("CCCCCCCC")).toBe(true);
	});

	it("still rebuilds from scratch when the layout is older than the adoptable one", async () => {
		const t = setup();
		library(t.zotero);
		let state: SyncState | null = { format: 3, version: 10, ftVersion: 6, queue: [] };
		const result = await runSync({ zotero: t.zotero, index: t.index, load: async () => state, save: async (s) => void (state = structuredClone(s)) });
		expect(result.indexed).toBe(2);
		expect(t.index.docs.size).toBe(2);
		expect(EMPTY_STATE.hashes).toEqual({});
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

	it("indexes everything again when the document format has changed", async () => {
		const t = setup();
		library(t.zotero);
		await t.run();
		const saved = t.state();
		expect(saved.format).toBe(DOCUMENT_FORMAT);

		// A state written by an older layout, with the library already "up to date" and nothing queued.
		const old = setup();
		library(old.zotero);
		await old.index.upsert("AAAAAAAA", "stale", { title: "", year: "", itemtype: "", doi: "", creators: "" });
		const run = runSync({ zotero: old.zotero, index: old.index, load: async () => ({ version: 10, ftVersion: 6, queue: [] }), save: async () => {} });
		const result = await run;
		expect(result.indexed).toBe(2);
		expect(old.index.docs.get("AAAAAAAA")?.text).toContain("Corals bleach");
		expect(result.state.format).toBe(DOCUMENT_FORMAT);
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
