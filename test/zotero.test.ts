import { describe, expect, it } from "vitest";
import { BudgetExhausted, Zotero, ZoteroError, parseJson } from "../src/zotero";

describe("Zotero client", () => {
	it("sends the key and API version, and reads the library under the user's id", async () => {
		const response = await new Zotero().get("/items/top", { q: "reef", tag: ["a", "b"], skipped: undefined, limit: 5 });
		const echo = parseJson<{ path: string; query: Record<string, string>; headers: Record<string, string> }>(response);

		expect(echo.path).toBe("/users/12345/items/top");
		expect(echo.headers["zotero-api-key"]).toBe("test-zotero-key");
		expect(echo.headers["zotero-api-version"]).toBe("3");
		expect(echo.query).toMatchObject({ q: "reef", limit: "5" });
		expect(echo.query.skipped).toBeUndefined();
		expect(response.version).toBe(42);
		expect(response.total).toBe(7);
	});

	it("repeats an array parameter", async () => {
		const response = await new Zotero().get("/items", { tag: ["a", "b"] });
		// The echo keeps only the last value of a repeated name, which is enough to show it was sent.
		expect(parseJson<{ query: Record<string, string> }>(response).query.tag).toBe("b");
	});

	it("explains a refusal without leaking the key", async () => {
		const error = await new Zotero().get("/forbidden").catch((e) => e);
		expect(error).toBeInstanceOf(ZoteroError);
		expect(error.status).toBe(403);
		expect(error.message).toContain("ZOTERO_API_KEY");
		expect(error.message).not.toContain("test-zotero-key");
	});

	it("gives up on a rate limit that asks for a long wait", async () => {
		const error = await new Zotero().get("/limited").catch((e) => e);
		expect(error).toBeInstanceOf(ZoteroError);
		expect(error.status).toBe(429);
	});

	it("stops when its request budget is spent", async () => {
		const zotero = new Zotero(1);
		await zotero.get("/items");
		await expect(zotero.get("/items")).rejects.toBeInstanceOf(BudgetExhausted);
		expect(zotero.hasBudget()).toBe(false);
	});
});
