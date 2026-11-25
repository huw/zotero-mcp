import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway key pair stands in for the Access team's signing key. Tests sign with the private half; the Worker fetches the public half.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };
const privateJwk = { ...privateKey.export({ format: "jwk" }), kid: "test", alg: "RS256" };

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.test.jsonc" },
			miniflare: {
				bindings: {
					ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
					ACCESS_AUD: "test-aud",
					ZOTERO_API_KEY: "test-zotero-key",
					ZOTERO_USER_ID: "12345",
					TEST_ACCESS_PRIVATE_JWK: JSON.stringify(privateJwk),
				},
				outboundService: (request: Request) => {
					const url = new URL(request.url);
					if (url.href === "https://test.cloudflareaccess.com/cdn-cgi/access/certs") {
						return Response.json({ keys: [publicJwk] });
					}
					// Stands in for Zotero: echoes the request, so tests can check what the client sent.
					if (url.hostname === "api.zotero.org") {
						const echo = { path: url.pathname, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(request.headers) };
						if (url.pathname.endsWith("/forbidden")) {
							return new Response("Forbidden", { status: 403 });
						}
						if (url.pathname.endsWith("/limited")) {
							return new Response("Slow down", { status: 429, headers: { "Retry-After": "60" } });
						}
						return Response.json(echo, { headers: { "Last-Modified-Version": "42", "Total-Results": "7", Backoff: "0" } });
					}
					return new Response(`Unmocked request: ${request.url}`, { status: 500 });
				},
			},
		}),
	],
	// The first request into the Worker loads the whole bundle, which takes several seconds in the test runner.
	test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
