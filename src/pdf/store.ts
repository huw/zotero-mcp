import { type ZoteroItem, ZoteroError, parseJson, type ZoteroWriter } from "../zotero";

/** The title given to attachments this server adds, which is also how an earlier half-finished attempt is recognised. */
export const ATTACHMENT_TITLE = "Full Text PDF (open access)";

export type UploadSource = {
	size: number;
	md5: string;
	/** Builds the upload body from Zotero's multipart prefix and suffix. A streamed source fetches its bytes only here, once the upload is authorised. */
	body(prefix: Uint8Array, suffix: Uint8Array): Promise<BodyInit>;
};

type Authorization = { exists: 1 } | { url: string; contentType: string; prefix: string; suffix: string; uploadKey: string };

const IF_NONE_MATCH = { "If-None-Match": "*" };

/** A fixed-length stream of prefix, then the source's bytes, then suffix, so a large file can be sent without being held in memory. */
export function framedStream(prefix: Uint8Array, source: ReadableStream<Uint8Array>, size: number, suffix: Uint8Array) {
	const { readable, writable } = new FixedLengthStream(prefix.byteLength + size + suffix.byteLength);
	void (async () => {
		const writer = writable.getWriter();
		await writer.write(prefix);
		const reader = source.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			await writer.write(value);
		}
		await writer.write(suffix);
		await writer.close();
	})().catch((error) => writable.abort(error));
	return readable;
}

/** Zotero's file upload: authorise, send the bytes where it says, then confirm. Returns "exists" when Zotero already holds identical bytes. */
export async function uploadAttachmentFile(
	zotero: ZoteroWriter,
	attachmentKey: string,
	filename: string,
	source: UploadSource,
	send: typeof fetch = fetch,
): Promise<"uploaded" | "exists"> {
	const path = `/items/${attachmentKey}/file`;
	const authorization = parseJson<Authorization>(
		await zotero.sendForm(path, { md5: source.md5, filename, filesize: String(source.size), mtime: String(Date.now()) }, IF_NONE_MATCH),
	);
	if ("exists" in authorization) {
		return "exists";
	}

	const encoder = new TextEncoder();
	const response = await send(authorization.url, {
		method: "POST",
		headers: { "Content-Type": authorization.contentType },
		body: await source.body(encoder.encode(authorization.prefix), encoder.encode(authorization.suffix)),
	});
	if (response.status !== 201) {
		throw new ZoteroError(`Zotero's file store refused the upload (HTTP ${response.status}).`, response.status);
	}
	await response.body?.cancel();

	await zotero.sendForm(path, { upload: authorization.uploadKey }, IF_NONE_MATCH);
	return "uploaded";
}

type MultiWrite = { success?: Record<string, string>; successful?: Record<string, { key: string }>; failed?: Record<string, { message: string }> };

/** Creates the empty attachment item the file is then uploaded to. */
async function createAttachment(zotero: ZoteroWriter, parentKey: string, filename: string, sourceUrl: string) {
	const item = {
		itemType: "attachment",
		parentItem: parentKey,
		linkMode: "imported_url",
		title: ATTACHMENT_TITLE,
		url: sourceUrl,
		accessDate: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
		contentType: "application/pdf",
		filename,
	};
	const response = await zotero.send("POST", "/items", [item], { "Zotero-Write-Token": crypto.randomUUID().replaceAll("-", "") });
	const body = parseJson<MultiWrite>(response);
	const key = Object.values(body.success ?? {})[0] ?? Object.values(body.successful ?? {})[0]?.key;
	if (!key) {
		throw new Error(`Zotero would not create the attachment: ${Object.values(body.failed ?? {})[0]?.message ?? "no reason given"}.`);
	}
	return key;
}

/** An attachment of ours from an earlier attempt that never got its file: reused, so a retry does not leave a second empty one. */
export function findOrphan(children: ZoteroItem[]) {
	return children.find((child) => child.data.itemType === "attachment" && child.data.title === ATTACHMENT_TITLE && !child.data.md5 && !child.data.deleted);
}

/** True if the item already has a PDF stored in Zotero. */
export function hasStoredPdf(children: ZoteroItem[]) {
	return children.some(
		(child) => child.data.itemType === "attachment" && child.data.contentType === "application/pdf" && Boolean(child.data.md5) && !child.data.deleted,
	);
}

/**
 * Attaches a PDF to an item and uploads it. If the upload fails the attachment this call made is moved to the trash, so a
 * failure leaves nothing half-made behind. (Trashed, not deleted: nothing here removes anything for good.)
 */
export async function storePdf(
	zotero: ZoteroWriter,
	parentKey: string,
	input: { filename: string; sourceUrl: string; source: UploadSource; orphanKey?: string },
	send: typeof fetch = fetch,
) {
	const created = input.orphanKey === undefined;
	const attachmentKey = input.orphanKey ?? (await createAttachment(zotero, parentKey, input.filename, input.sourceUrl));
	try {
		const result = await uploadAttachmentFile(zotero, attachmentKey, input.filename, input.source, send);
		return { attachmentKey, result };
	} catch (error) {
		if (created) {
			try {
				const item = parseJson<ZoteroItem>(await zotero.get(`/items/${attachmentKey}`, { format: "json" }));
				await zotero.send("PATCH", `/items/${attachmentKey}`, { deleted: 1 }, { "If-Unmodified-Since-Version": String(item.version) });
			} catch (cleanup) {
				console.error("Could not tidy up an attachment", { error: cleanup instanceof Error ? cleanup.message : String(cleanup) });
			}
		}
		throw error;
	}
}
