/** Up to this size a PDF is held in memory, uploaded and have its text extracted. */
export const EXTRACT_MAX_BYTES = 20 * 1024 * 1024;
/** Up to this size a PDF is stored in Zotero, streamed so that it is never held in memory whole. Text is left for Zotero Desktop to extract. */
export const STORE_MAX_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class PdfError extends Error {}
export class TooLargeError extends PdfError {}

/**
 * Only plain https addresses on named hosts. A fetch from here can never be pointed at an IP address, localhost, an internal
 * name, a non-standard port, or an address with embedded credentials, whatever a redirect or a metadata record says.
 */
export function checkSourceUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new PdfError(`"${raw}" is not a valid address.`);
	}
	const host = url.hostname;
	const refused =
		url.protocol !== "https:" ||
		(url.port !== "" && url.port !== "443") ||
		url.username !== "" ||
		url.password !== "" ||
		!host.includes(".") ||
		host.includes(":") ||
		/^[\d.]+$/.test(host) ||
		/(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(host);
	if (refused) {
		throw new PdfError(`Refusing to fetch ${url.protocol}//${host}: only https addresses on public host names are allowed.`);
	}
	return url;
}

/** Opens a PDF source, following redirects by hand so that every hop is checked. */
export async function openSource(raw: string, fetchFn: typeof fetch = fetch): Promise<Response> {
	let url = checkSourceUrl(raw);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await fetchFn(url, { redirect: "manual", headers: { Accept: "application/pdf,*/*;q=0.5", "User-Agent": "zotero-mcp open-access PDF fetch" } });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("Location");
			if (!location) {
				throw new PdfError(`${url.hostname} redirected without saying where.`);
			}
			await response.body?.cancel();
			url = checkSourceUrl(new URL(location, url).href);
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new PdfError(`${url.hostname} answered HTTP ${response.status}.`);
		}
		const length = Number(response.headers.get("Content-Length"));
		if (length > STORE_MAX_BYTES) {
			await response.body?.cancel();
			throw new TooLargeError(`The PDF is ${(length / 1048576).toFixed(0)} MB, over the ${STORE_MAX_BYTES / 1048576} MB limit.`);
		}
		if (!response.body) {
			throw new PdfError(`${url.hostname} sent an empty answer.`);
		}
		return response;
	}
	throw new PdfError("Too many redirects.");
}

const MAGIC = new TextEncoder().encode("%PDF-");

/** A real PDF starts with %PDF- (allowing a little junk before it). A paywall or login page that answered 200 does not. */
export function looksLikePdf(head: Uint8Array) {
	const end = Math.min(head.length, 1024) - MAGIC.length;
	for (let i = 0; i <= end; i++) {
		if (MAGIC.every((byte, j) => head[i + j] === byte)) {
			return true;
		}
	}
	return false;
}

/** Counts and caps the bytes passing through, and keeps the first kilobyte to check it is a PDF. */
function guard(maxBytes: number) {
	const state = { size: 0, head: new Uint8Array(0) };
	const stream = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			state.size += chunk.byteLength;
			if (state.size > maxBytes) {
				throw new TooLargeError(`The PDF is over the ${maxBytes / 1048576} MB limit.`);
			}
			if (state.head.length < 1024) {
				const take = chunk.subarray(0, 1024 - state.head.length);
				const joined = new Uint8Array(state.head.length + take.length);
				joined.set(state.head);
				joined.set(take, state.head.length);
				state.head = joined;
			}
			controller.enqueue(chunk);
		},
	});
	return { state, stream };
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Reads a whole PDF into memory, for one small enough to extract text from. */
export async function readPdf(response: Response, maxBytes = EXTRACT_MAX_BYTES) {
	const { state, stream } = guard(maxBytes);
	const bytes = new Uint8Array(await new Response(response.body?.pipeThrough(stream)).arrayBuffer());
	if (!looksLikePdf(state.head)) {
		throw new PdfError("The address did not return a PDF (probably a paywall or login page).");
	}
	const md5 = hex(await crypto.subtle.digest("MD5", bytes));
	return { bytes, size: bytes.byteLength, md5 };
}

/** Hashes a PDF as it streams past, without keeping it. Zotero needs the hash and size before it will accept the file. */
export async function hashPdf(response: Response, maxBytes = STORE_MAX_BYTES) {
	const { state, stream } = guard(maxBytes);
	const digest = new crypto.DigestStream("MD5");
	// If the stream fails partway (over the size cap, say), the digest rejects too, with no one waiting on it.
	const result = digest.digest;
	result.catch(() => {});
	await response.body?.pipeThrough(stream).pipeTo(digest);
	if (!looksLikePdf(state.head)) {
		throw new PdfError("The address did not return a PDF (probably a paywall or login page).");
	}
	return { size: state.size, md5: hex(await result) };
}
