import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { createMcpHandler } from "agents/mcp/server";
import { isFromAccess } from "./access";
import { annotationsFor, selectTools, writeModeOf } from "./registry";
import { aiSearchIndex, type SearchIndex } from "./search-index";
import { EMPTY_STATE, runSync, type SyncState } from "./sync";
import { createTools } from "./tools";
import { createPdfTools, type PdfJobs } from "./pdf/tools";
import { createWriteTools } from "./write-tools";
import { redact, Zotero } from "./zotero";

const validator = new CfWorkerJsonSchemaValidator();
const STATE_KEY = "state";

/** A cron invocation may make 50 outside requests on the Workers Free plan, Zotero's and the search index's together. Set SYNC_REQUEST_BUDGET higher on a paid plan. */
const DEFAULT_SYNC_BUDGET = 44;

/** Charges each call to the search index against the sync's request budget, so the total stays under the platform's limit. */
function counted(index: SearchIndex, zotero: Zotero): SearchIndex {
	return {
		async ensure() {
			zotero.spend(2);
			await index.ensure();
		},
		async upsert(key, text, metadata) {
			zotero.spend(1);
			await index.upsert(key, text, metadata);
		},
		async remove(key) {
			zotero.spend(2);
			await index.remove(key);
		},
	};
}

function createServer(env: Env) {
	const server = new McpServer({ name: "zotero-mcp", version: "0.1.0" });
	const zotero = new Zotero();
	const reads = createTools({
		zotero,
		search: (query, limit, filters) =>
			env.AI_SEARCH.get(env.AI_SEARCH_INSTANCE).search({
				query,
				ai_search_options: { retrieval: { retrieval_type: "hybrid", max_num_results: limit, ...(Object.keys(filters).length > 0 ? { filters } : {}) } },
			}),
		async status() {
			const state = (await env.SYNC_STATE.get<SyncState>(STATE_KEY, "json")) ?? EMPTY_STATE;
			return {
				waitingToBeIndexed: state.queue.length,
				readingChangesFromZotero: state.discover !== undefined,
				zoteroLibraryVersion: state.version,
				lastRun: state.lastRun ?? "The sync has not run yet.",
			};
		},
	});

	const jobs: PdfJobs = {
		async start(itemKey) {
			const id = `pdf-${itemKey}-${Date.now().toString(36)}`;
			await env.PDF_WORKFLOW.create({ id, params: { itemKey } });
			return id;
		},
		async status(id) {
			return (await env.PDF_WORKFLOW.get(id)).status();
		},
	};
	const tools = selectTools(writeModeOf(env.WRITE_MODE), reads, [...createWriteTools({ zotero }), ...createPdfTools({ zotero, jobs })]);
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema, validator),
				annotations: annotationsFor(tool),
			},
			async (input) => {
				try {
					return await tool.handler(input);
				} catch (error) {
					// Zotero refusals and the tools' own checks ("No such item", "not a DOI") are messages meant for Claude.
					return { isError: true, content: [{ type: "text", text: redact(error instanceof Error ? error.message : String(error)) }] };
				}
			},
		);
	}
	return server;
}

export { AttachPdfWorkflow } from "./pdf/workflow";

export default {
	async fetch(request, env, ctx) {
		if (new URL(request.url).pathname !== "/mcp") {
			return new Response("Not found", { status: 404 });
		}
		if (!(await isFromAccess(request))) {
			return new Response("Forbidden", { status: 403 });
		}
		return createMcpHandler(() => createServer(env))(request, env, ctx);
	},

	async scheduled(controller, env, ctx) {
		ctx.waitUntil(
			(async () => {
				console.log("Zotero sync starting", { cron: controller.cron });
				try {
					const zotero = new Zotero(Number(env.SYNC_REQUEST_BUDGET) || DEFAULT_SYNC_BUDGET);
					const result = await runSync({
						zotero,
						index: counted(aiSearchIndex(), zotero),
						load: () => env.SYNC_STATE.get<SyncState>(STATE_KEY, "json"),
						save: (state) => env.SYNC_STATE.put(STATE_KEY, JSON.stringify(state)),
					});
					console.log("Zotero sync finished", { indexed: result.indexed, removed: result.removed, waiting: result.state.queue.length, requests: zotero.calls, error: result.error });
				} catch (error) {
					// Reached only if reading or saving the sync state fails, which runSync cannot record itself.
					console.error("Zotero sync could not run", { error: error instanceof Error ? error.message : String(error) });
				}
			})(),
		);
	},
} satisfies ExportedHandler<Env>;
