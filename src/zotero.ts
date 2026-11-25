import { env } from "cloudflare:workers";

const REDACTED = "[redacted]";
const MAX_RETRIES = 3;
const MAX_WAIT_SECONDS = 15;

export type Params = Record<string, string | number | boolean | string[] | undefined>;

export type ZoteroResponse = {
	status: number;
	/** The library version, from Last-Modified-Version. */
	version: number | undefined;
	/** Total-Results, on list endpoints. */
	total: number | undefined;
	body: string;
};

/** What the tools and the sync need from Zotero. The real client below implements it; tests fake it. */
export interface ZoteroLike {
	get(path: string, params?: Params, headers?: Record<string, string>): Promise<ZoteroResponse>;
	/** True while `count` more requests fit in this invocation's budget. */
	hasBudget(count?: number): boolean;
}

export class ZoteroError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export class BudgetExhausted extends Error {
	constructor() {
		super("Out of Zotero requests for this invocation");
	}
}

/** Removes the API key from anything that reaches the model or the logs. */
export function redact(text: string) {
	return env.ZOTERO_API_KEY ? text.replaceAll(env.ZOTERO_API_KEY, REDACTED) : text;
}

function explain(status: number, path: string, detail: string) {
	switch (status) {
		case 403:
			return `Zotero refused the request (HTTP 403) for ${path}. Check that the ZOTERO_API_KEY secret is valid and may read this library. ${detail}`;
		case 404:
			return `Zotero found nothing at ${path} (HTTP 404). The key may be wrong, or the item may have no content.`;
		case 429:
			return `Zotero rate limit (HTTP 429) for ${path} did not clear after retries. Wait a minute and retry.`;
		default:
			return `Zotero returned HTTP ${status} for ${path}: ${detail}`;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A client for the user library on the Zotero Web API v3. It sends the API key and version headers, honours Zotero's
 * Backoff header, retries a short 429 or 503, and counts requests so a cron invocation can stay inside its subrequest limit.
 */
export class Zotero implements ZoteroLike {
	calls = 0;
	private backoffUntil = 0;

	constructor(private readonly budget = Number.POSITIVE_INFINITY) {}

	hasBudget(count = 1) {
		return this.calls + count <= this.budget;
	}

	async get(path: string, params: Params = {}, headers: Record<string, string> = {}): Promise<ZoteroResponse> {
		const url = new URL(`https://api.zotero.org/users/${env.ZOTERO_USER_ID}${path}`);
		for (const [name, value] of Object.entries(params)) {
			if (value === undefined) {
				continue;
			}
			for (const item of Array.isArray(value) ? value : [value]) {
				url.searchParams.append(name, String(item));
			}
		}

		for (let attempt = 0; ; attempt++) {
			const backoff = this.backoffUntil - Date.now();
			if (backoff > 0) {
				await sleep(Math.min(backoff, MAX_WAIT_SECONDS * 1000));
			}
			if (!this.hasBudget()) {
				throw new BudgetExhausted();
			}
			this.calls++;

			const response = await fetch(url, {
				headers: { "Zotero-API-Key": env.ZOTERO_API_KEY, "Zotero-API-Version": "3", ...headers },
			});
			const asked = Number(response.headers.get("Backoff"));
			if (asked > 0) {
				this.backoffUntil = Date.now() + asked * 1000;
			}

			if (response.ok || response.status === 304) {
				const version = Number(response.headers.get("Last-Modified-Version"));
				const total = Number(response.headers.get("Total-Results"));
				return {
					status: response.status,
					version: Number.isFinite(version) && response.headers.has("Last-Modified-Version") ? version : undefined,
					total: Number.isFinite(total) && response.headers.has("Total-Results") ? total : undefined,
					body: response.status === 304 ? "" : await response.text(),
				};
			}

			const retryable = response.status === 429 || response.status === 503;
			const waitSeconds = Number(response.headers.get("Retry-After") ?? 2 ** attempt);
			if (retryable && attempt < MAX_RETRIES && waitSeconds <= MAX_WAIT_SECONDS) {
				await sleep(waitSeconds * 1000);
				continue;
			}

			console.error("Zotero request failed", { "http.status": response.status, "http.path": url.pathname });
			const detail = redact(await response.text()).slice(0, 500);
			throw new ZoteroError(explain(response.status, url.pathname, detail), response.status);
		}
	}
}

export type ZoteroItem = {
	key: string;
	version: number;
	meta?: { creatorSummary?: string; parsedDate?: string; numChildren?: number };
	data: {
		itemType: string;
		title?: string;
		creators?: { creatorType?: string; firstName?: string; lastName?: string; name?: string }[];
		abstractNote?: string;
		date?: string;
		DOI?: string;
		publicationTitle?: string;
		url?: string;
		tags?: { tag: string }[];
		parentItem?: string;
		deleted?: number | boolean;
		contentType?: string;
		linkMode?: string;
		note?: string;
		[field: string]: unknown;
	};
};

export function parseJson<T>(response: ZoteroResponse): T {
	return JSON.parse(response.body) as T;
}
