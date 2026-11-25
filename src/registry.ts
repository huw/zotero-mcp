import type { Tool, ToolKind } from "./tools";

/**
 * off: the server only reads. additive: it can also add to the library but never remove or overwrite. full: everything.
 * Anything else is treated as off, so a typo cannot switch writes on.
 */
export type WriteMode = "off" | "additive" | "full";

export function writeModeOf(value: string | undefined): WriteMode {
	return value === "additive" || value === "full" ? value : "off";
}

/** The tools a server in this mode offers. Tools outside the mode are not registered at all, so Claude cannot even see them. */
export function selectTools(mode: WriteMode, reads: Tool[], writes: Tool[]) {
	// Tools that only read are always offered, wherever they are listed.
	const allowed: ToolKind[] = mode === "full" ? ["read", "write", "destructive"] : mode === "additive" ? ["read", "write"] : ["read"];
	return [...reads, ...writes.filter((tool) => allowed.includes(tool.kind ?? "read"))];
}

/** Claude groups a connector's tools by these hints, and lets each tool be allowed, set to ask first, or blocked. */
export function annotationsFor(tool: Tool) {
	const kind = tool.kind ?? "read";
	return {
		readOnlyHint: kind === "read",
		destructiveHint: kind === "destructive",
		idempotentHint: kind === "read",
		openWorldHint: tool.openWorld ?? false,
	};
}
