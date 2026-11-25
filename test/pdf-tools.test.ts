import { describe, expect, it } from "vitest";
import { createPdfTools, type PdfJobs } from "../src/pdf/tools";
import { annotationsFor, selectTools } from "../src/registry";
import type { Tool } from "../src/tools";
import type { ZoteroResponse, ZoteroWriter } from "../src/zotero";
import { item } from "./fakes";

function setup(library = [item("AAAAAAAA", 1, { title: "Paper A" }), item("BBBBBBBB", 1, { title: "Paper B" })]) {
	const started: string[] = [];
	const jobs: PdfJobs = {
		async start(key) {
			started.push(key);
			return `pdf-${key}-x`;
		},
		async status(id) {
			if (id === "pdf-missing") throw new Error("no such instance");
			return id === "pdf-AAAAAAAA-x" ? { status: "complete", output: { status: "done", attachmentKey: "ATTACHME" } } : { status: "running" };
		},
	};
	const zotero = {
		hasBudget: () => true,
		async get(_path: string, params: Record<string, unknown> = {}): Promise<ZoteroResponse> {
			const keys = String(params.itemKey).split(",");
			return { status: 200, version: 1, total: undefined, body: JSON.stringify(library.filter((i) => keys.includes(i.key))) };
		},
	} as unknown as ZoteroWriter;
	const tools = createPdfTools({ zotero, jobs });
	const tool = (name: string) => tools.find((t) => t.name === name) as Tool;
	return { tools, tool, started };
}
const parse = (r: Awaited<ReturnType<Tool["handler"]>>) => JSON.parse((r.content[0] as { text: string }).text);

describe("attach_open_access_pdf", () => {
	it("starts one background job per paper and says where to look next", async () => {
		const { tool, started } = setup();
		const result = parse(await tool("attach_open_access_pdf").handler({ keys: ["AAAAAAAA", "BBBBBBBB"] }));
		expect(started).toEqual(["AAAAAAAA", "BBBBBBBB"]);
		expect(result.started).toEqual([
			{ key: "AAAAAAAA", title: "Paper A", job: "pdf-AAAAAAAA-x" },
			{ key: "BBBBBBBB", title: "Paper B", job: "pdf-BBBBBBBB-x" },
		]);
		expect(result.next).toContain("pdf_job_status");
	});

	it("starts nothing if any key is not in the library", async () => {
		const { tool, started } = setup();
		await expect(tool("attach_open_access_pdf").handler({ keys: ["AAAAAAAA", "ZZZZZZZZ"] })).rejects.toThrow("No such item: ZZZZZZZZ");
		expect(started).toEqual([]);
	});

	it("limits a call to 10 papers, in its schema", () => {
		const schema = setup().tool("attach_open_access_pdf").inputSchema as { properties: { keys: { maxItems: number } } };
		expect(schema.properties.keys.maxItems).toBe(10);
	});
});

describe("pdf_job_status", () => {
	it("reports each job, including its result, and copes with an unknown one", async () => {
		const result = parse(await setup().tool("pdf_job_status").handler({ jobs: ["pdf-AAAAAAAA-x", "pdf-BBBBBBBB-x", "pdf-missing"] }));
		expect(result).toEqual([
			{ job: "pdf-AAAAAAAA-x", status: "complete", result: { status: "done", attachmentKey: "ATTACHME" } },
			{ job: "pdf-BBBBBBBB-x", status: "running" },
			{ job: "pdf-missing", status: "unknown", error: "No such job." },
		]);
	});
});

describe("how the tools are labelled and offered", () => {
	it("marks the fetch as a write that reaches the web, and the status check as read-only", () => {
		const { tool } = setup();
		expect(annotationsFor(tool("attach_open_access_pdf"))).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
		expect(annotationsFor(tool("pdf_job_status"))).toMatchObject({ readOnlyHint: true, destructiveHint: false });
	});

	it("offers the fetch only when writes are on, but always the status check", () => {
		const { tools } = setup();
		const names = (mode: "off" | "additive" | "full") => selectTools(mode, [], tools).map((t) => t.name);
		expect(names("off")).toEqual(["pdf_job_status"]);
		expect(names("additive")).toEqual(["attach_open_access_pdf", "pdf_job_status"]);
		expect(names("full")).toEqual(["attach_open_access_pdf", "pdf_job_status"]);
	});
});
