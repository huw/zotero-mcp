import { fetchItems } from "../write-tools";
import { key, text, type Tool } from "../tools";
import type { ZoteroWriter } from "../zotero";

/** The two things the tools need from the workflow binding. */
export type PdfJobs = {
	start(itemKey: string): Promise<string>;
	status(id: string): Promise<{ status: string; output?: unknown; error?: unknown }>;
};

export function createPdfTools({ zotero, jobs }: { zotero: ZoteroWriter; jobs: PdfJobs }): Tool[] {
	return [
		{
			name: "attach_open_access_pdf",
			kind: "write",
			openWorld: true,
			description:
				"Find a legal open-access PDF for up to 10 papers (by their DOI, through OpenAlex and Unpaywall), store it in your Zotero storage as an attachment, and add its text to Zotero's full-text index so it becomes searchable. Papers that already have a PDF are skipped. This runs in the background and takes a minute or two per paper: it returns job ids straight away, and pdf_job_status reports how each went. Files over 20 MB are stored without text (Zotero Desktop extracts it when it syncs), and over 100 MB are skipped. Only open-access copies are fetched; paywalled papers need Zotero Desktop's Find Available PDF.",
			inputSchema: { type: "object", properties: { keys: { type: "array", items: key("A paper"), minItems: 1, maxItems: 10, uniqueItems: true } }, required: ["keys"] },
			async handler(input) {
				const found = await fetchItems(zotero, input.keys);
				const started = [];
				for (const itemKey of input.keys as string[]) {
					started.push({ key: itemKey, title: found.get(itemKey)?.data.title, job: await jobs.start(itemKey) });
				}
				return text({ started, next: "Call pdf_job_status with these job ids in a minute or two." });
			},
		},
		{
			name: "pdf_job_status",
			description: "How the PDF jobs started by attach_open_access_pdf are going: queued, running, done (with what was attached and whether its text was extracted), skipped (with why), or failed.",
			inputSchema: { type: "object", properties: { jobs: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, minItems: 1, maxItems: 10 } }, required: ["jobs"] },
			async handler(input) {
				const statuses = [];
				for (const id of input.jobs as string[]) {
					try {
						const { status, output, error } = await jobs.status(id);
						statuses.push({ job: id, status, ...(output ? { result: output } : {}), ...(error ? { error } : {}) });
					} catch {
						statuses.push({ job: id, status: "unknown", error: "No such job." });
					}
				}
				return text(statuses);
			},
		},
	];
}
