import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { createMcpHandler } from "agents/mcp/server";
import { isFromAccess } from "./access";
import { annotationsFor, selectTools, writeModeOf } from "./registry";
import { aiSearchIndex } from "./search-index";
import { EMPTY_STATE, runSync, type SyncState } from "./sync";
import { createTools } from "./tools";
import { createWriteTools } from "./write-tools";
import { redact, Zotero } from "./zotero";

const validator = new CfWorkerJsonSchemaValidator();
const STATE_KEY = "state";

/** A cron invocation may make 50 outside requests on the Workers Free plan. Set SYNC_REQUEST_BUDGET higher on a paid plan. */
const DEFAULT_SYNC_BUDGET = 45;

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

	const tools = selectTools(writeModeOf(env.WRITE_MODE), reads, createWriteTools({ zotero }));
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

	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(
			runSync({
				zotero: new Zotero(Number(env.SYNC_REQUEST_BUDGET) || DEFAULT_SYNC_BUDGET),
				index: aiSearchIndex(),
				load: () => env.SYNC_STATE.get<SyncState>(STATE_KEY, "json"),
				save: (state) => env.SYNC_STATE.put(STATE_KEY, JSON.stringify(state)),
			}),
		);
	},
} satisfies ExportedHandler<Env>;
