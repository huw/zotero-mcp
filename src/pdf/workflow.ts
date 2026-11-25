import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Zotero } from "../zotero";
import type { MarkdownConverter } from "./extract";
import { extract, locate, type PipelineDeps, store } from "./pipeline";

export type AttachParams = { itemKey: string };
export type AttachResult =
	| { status: "skipped"; reason: string; title?: string }
	| { status: "done"; title?: string; attachmentKey: string; file: string; megabytes: number; source: string; license?: string | null; extracted: boolean; note: string };

const STEP = { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" } as const;

/** Finds an open-access PDF for one paper, stores it in Zotero, and puts its text in Zotero's full-text index. Each step can be retried on its own. */
export class AttachPdfWorkflow extends WorkflowEntrypoint<Env, AttachParams> {
	async run(event: WorkflowEvent<AttachParams>, step: WorkflowStep): Promise<AttachResult> {
		const deps: PipelineDeps = {
			zotero: new Zotero(),
			ai: this.env.AI as unknown as MarkdownConverter,
			unpaywallEmail: this.env.UNPAYWALL_EMAIL || undefined,
		};
		const itemKey = event.payload.itemKey;

		const plan = await step.do("find an open-access PDF", { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" }, () => locate(deps, itemKey));
		if (plan.skip) {
			return { status: "skipped", reason: plan.skip, title: plan.title };
		}
		const stored = await step.do("store the PDF in Zotero", STEP, () => store(deps, plan));
		const extraction = await step.do("extract its text", STEP, () => extract(deps, stored));

		return {
			status: "done",
			title: plan.title,
			attachmentKey: stored.attachmentKey,
			file: stored.filename,
			megabytes: Math.round((stored.size / 1048576) * 10) / 10,
			source: new URL(stored.source).hostname,
			license: stored.license,
			extracted: extraction.extracted,
			note: extraction.note,
		};
	}
}
