/** A place a paper's PDF can be fetched from, found through a service that lists legal open-access copies. */
export type PdfCandidate = { url: string; source: "openalex" | "unpaywall"; license?: string | null };

type OpenAlexLocation = { is_oa?: boolean; pdf_url?: string | null; license?: string | null };
type OpenAlexWork = { best_oa_location?: OpenAlexLocation | null; locations?: OpenAlexLocation[] };
type UnpaywallLocation = { url_for_pdf?: string | null; license?: string | null };
type UnpaywallWork = { is_oa?: boolean; best_oa_location?: UnpaywallLocation | null; oa_locations?: UnpaywallLocation[] };

const MAX_CANDIDATES = 5;
const HEADERS = { Accept: "application/json", "User-Agent": "zotero-mcp open-access PDF lookup" };

async function lookup<T>(url: string, fetchFn: typeof fetch): Promise<T | undefined> {
	const response = await fetchFn(url, { headers: HEADERS });
	if (response.status === 404) {
		return undefined;
	}
	if (!response.ok) {
		throw new Error(`${new URL(url).hostname} answered HTTP ${response.status}.`);
	}
	return (await response.json()) as T;
}

/**
 * Finds legal open-access PDFs for a DOI: OpenAlex first (it needs no key), then Unpaywall if an email is configured (it asks
 * for one). Only links these services report as open access are used. Nothing here accepts a URL from the caller.
 */
export async function findPdfCandidates(doi: string, options: { unpaywallEmail?: string; fetchFn?: typeof fetch } = {}): Promise<PdfCandidate[]> {
	const fetchFn = options.fetchFn ?? fetch;
	const found: PdfCandidate[] = [];
	const add = (url: string | null | undefined, source: PdfCandidate["source"], license?: string | null) => {
		if (url && !found.some((candidate) => candidate.url === url)) {
			found.push({ url, source, license });
		}
	};

	try {
		const work = await lookup<OpenAlexWork>(`https://api.openalex.org/works/doi:${encodeURI(doi)}?select=best_oa_location,locations`, fetchFn);
		add(work?.best_oa_location?.pdf_url, "openalex", work?.best_oa_location?.license);
		for (const location of work?.locations ?? []) {
			if (location.is_oa) {
				add(location.pdf_url, "openalex", location.license);
			}
		}
	} catch (error) {
		console.error("OpenAlex lookup failed", { error: error instanceof Error ? error.message : String(error) });
	}

	if (options.unpaywallEmail) {
		try {
			const work = await lookup<UnpaywallWork>(`https://api.unpaywall.org/v2/${encodeURI(doi)}?email=${encodeURIComponent(options.unpaywallEmail)}`, fetchFn);
			add(work?.best_oa_location?.url_for_pdf, "unpaywall", work?.best_oa_location?.license);
			for (const location of work?.oa_locations ?? []) {
				add(location.url_for_pdf, "unpaywall", location.license);
			}
		} catch (error) {
			console.error("Unpaywall lookup failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}
	return found.slice(0, MAX_CANDIDATES);
}
