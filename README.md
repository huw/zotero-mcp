# zotero-mcp

A personal remote MCP server for your [Zotero](https://www.zotero.org/) library, running on Cloudflare Workers. It speaks streamable HTTP at `/mcp`, so claude.ai, the Claude mobile apps and Claude's cloud sessions can use it as a custom connector. It is the hosted counterpart to running a local Zotero MCP server, built the same way as `toggl-mcp`.

- **Single user, behind Cloudflare Access.** Access is the OAuth provider, through Managed OAuth, and an Access policy decides who may sign in. The Worker verifies the JWT Access attaches to every request it lets through, and refuses anything without a valid one.
- **Writes are opt-in, narrow and labelled.** Claude can save papers and reorganise your library, but nothing is deleted for good, in bulk or library-wide, and every tool that removes or overwrites something is marked destructive so you can block it. `WRITE_MODE` turns the whole thing down to additive-only or off (see below).
- **Literature search two ways.** Keyword and full-text search straight against the Zotero Web API, and semantic search over your whole library through [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/).

A stateless `createMcpHandler` from the Agents SDK serves MCP. There is no Durable Object and no `/sse` endpoint.

## Tools

| Tool | What it does |
|---|---|
| `search_items` | Keyword search (`qmode` `titleCreatorYear`, or `everything` to include full text and notes). Filter by tag, item type and collection; sort by date added or modified. |
| `get_item` | One item's full metadata. |
| `get_item_children` | An item's attachments and notes (notes as plain text). |
| `get_fulltext` | The text Zotero extracted from a PDF, in pieces with `offset`. Accepts an item key or an attachment key. |
| `list_collections`, `list_tags` | Browse collections and tags. |
| `export_bibliography` | Formatted citations in any CSL style (`apa`, `chicago-author-date`, ...), or BibTeX, BibLaTeX, RIS, CSL JSON. |
| `semantic_search` | Search by meaning over titles, abstracts, your notes and full text. Optional item type and year range. Returns passages with the Zotero key to follow up. |
| `index_status` | How far the semantic index has got. |

### Tools that change your library

Claude's connector settings list every tool separately, and each can be set to always allow, ask first, or block. The tools below are marked as writes so they are grouped apart from the read tools, and the destructive ones start with `DESTRUCTIVE:` so it is obvious which to set to ask or block.

**Additive** (nothing is removed or overwritten):

| Tool | What it does |
|---|---|
| `add_paper_by_doi` | Save a paper from its DOI. Metadata comes from doi.org (Crossref and DataCite). Does nothing if the DOI is already in the library. Optionally files and tags it. No PDF is attached. |
| `create_item` | Add something with no DOI (web page, report, book). Fields the item type does not have are refused. |
| `add_note`, `add_tags`, `add_to_collection`, `create_collection` | Add a note, tags, or collection membership, to up to 50 items at a time where it makes sense. |
| `restore_item` | Take an item out of the trash. |

**Destructive** (removes, overwrites or moves something that was there):

| Tool | What it does |
|---|---|
| `update_item`, `update_note` | Overwrite field values, creators or a note's text. |
| `remove_tags`, `remove_from_collection` | Take tags or collection membership off up to 50 items. The items stay. |
| `update_collection` | Rename a collection or move it. |
| `trash_item` | Move **one** item to Zotero's trash, where it can be restored. |
| `delete_collection` | Delete **one** collection and its subcollections. Its items stay in the library. |

**Not offered, on purpose:** deleting anything permanently, deleting items or tags in bulk, emptying the trash, uploading files, group libraries, settings and API keys. Nothing can trigger a sync either; Zotero Desktop does that. Every edit checks the item's version first, so a change made in Zotero Desktop a moment earlier is never overwritten: Zotero refuses it and Claude is told to read the item again.

`WRITE_MODE` in `wrangler.jsonc` is a second switch that does not depend on Claude's settings: `off` registers no write tools at all, `additive` registers only the additive ones, `full` (the default) registers everything. Anything else counts as `off`.

Responses come back as Zotero sends them, minus the `library` and `links` boilerplate on every object, and with the API key replaced by `[redacted]` wherever it might appear.

## How semantic search works

A Cron Trigger runs every 10 minutes. Each run asks Zotero what changed since last time (one conditional request, so a quiet library costs almost nothing), then indexes the affected items into an AI Search instance with built-in storage:

- one Markdown file per top-level item, named `<ITEMKEY>.md`, holding the title, authors, year, tags, abstract, your notes and the full text Zotero extracted from its attachments;
- five metadata fields on each (`title`, `year`, `itemtype`, `doi`, `creators`), which `semantic_search` can filter on;
- a changed or new attachment, a changed note, a trashed item or a permanently deleted one all update or remove the right document.

The Worker creates the AI Search instance itself on the first run, with hybrid (vector plus keyword) retrieval.

Zotero's full text exists only once Zotero desktop has indexed the PDF and synced it, which happens after the item syncs. The sync tracks full-text changes separately, so an item is indexed again when its text arrives.

### Cost

AI Search includes 5 million ingestion tokens, 10 GB of storage and 1,000 semantic queries a month on every Workers plan. Text is cut at 400,000 characters per item (`MAX_FULLTEXT_CHARS` in `src/document.ts`). A library under 1,000 items is mostly inside the free allowance, but a first load of many long papers can use more than 5 million tokens; beyond that AI Search charges about $0.75 per million. Check the AI Search usage page after the first sync.

### Sync speed

A cron invocation may make 50 outside requests on the Workers Free plan, and each item costs a few (its children, plus one per attachment's text). `SYNC_REQUEST_BUDGET` (default 45) caps one run, and the queue carries over, so a first load of a few hundred items takes several hours, and after that a run is nearly always quick. On a paid plan, set `SYNC_REQUEST_BUDGET` to something like 900 in `wrangler.jsonc` to index much faster.

## Setup

You need a Cloudflare account with a Zero Trust organisation (the free plan is enough) and a Zotero account.

```sh
pnpm install
```

### 1. Make a Zotero API key

At [zotero.org/settings/keys](https://www.zotero.org/settings/keys), create a new key. Allow **library access** and **notes access**. Turn **write access** on only if you want Claude to change your library, and leave it off for a read-only server; with it off, the write tools fail with a clear error. Note the key. Your numeric **userID** is on the same page; put it in `wrangler.jsonc` as `ZOTERO_USER_ID`. It is not a secret.

### 2. Deploy the Worker

```sh
pnpm wrangler secret put ZOTERO_API_KEY
pnpm deploy   # also creates the SYNC_STATE KV namespace on the first deploy
```

Until step 4 is done, every request gets a 403, because nothing carries a valid Access JWT yet. The sync does not depend on Access, and starts at the next 10-minute mark.

### 3. Put Access in front of it

1. In the Cloudflare dashboard, open the Worker, then Settings, Domains & Routes. On the `workers.dev` route, turn on Cloudflare Access. This creates an Access application for the hostname.
2. In Zero Trust, Access controls, Applications, edit that application:
   - **Policy:** one Allow rule that includes only your email address. One-time PIN works as the login method with no other setup.
   - **Advanced settings:** turn on **Managed OAuth**. Under dynamic client registration, allow the redirect URI `https://claude.ai/api/mcp/auth_callback`. To use the MCP Inspector locally too, allow localhost.
3. Note the application's **Application Audience (AUD) tag** and your team domain, `<team>.cloudflareaccess.com`.

### 4. Tell the Worker which Access application to trust

In `wrangler.jsonc`:

```jsonc
"ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
"ACCESS_AUD": "<the AUD tag>"
```

Then run `pnpm deploy` again. The MCP endpoint is `https://zotero-mcp.<your-subdomain>.workers.dev/mcp`.

## Add it to claude.ai

1. Settings, Connectors, Add custom connector.
2. Paste the `/mcp` URL.
3. Sign in through Cloudflare Access when prompted.

Ask for `index_status` to watch the semantic index fill.

## Try it with the MCP Inspector

```sh
npx @modelcontextprotocol/inspector
```

Choose the Streamable HTTP transport, enter the `/mcp` URL, and use the OAuth flow, which signs you in through Access. Then call `search_items`.

## Develop

```sh
pnpm test          # runs inside workerd
pnpm type-check
```

`wrangler dev` sits behind no Access application, so a local server answers every request with 403. The AI Search binding only works against Cloudflare's network, so tests use `wrangler.test.jsonc`, which leaves it out, and fake both Zotero and the search index. The sync logic is tested against an in-memory Zotero library: first load, no-change runs, late-arriving full text, note changes, trashing and deleting, request budgets and resuming.

## Known limits

- Deleting an attachment does not mark its parent stale (Zotero does not bump the parent), so the parent's document keeps the old text until the parent next changes.
- Only the user library is covered, not group libraries.
- `add_paper_by_doi` does not attach a PDF. Attaching files means storing them in Zotero's file storage, which this server does not do.
- AI Search allows five custom metadata fields per instance, so tags and collections are searchable as text inside each document but cannot be used as filters.
- Full text is limited to what Zotero itself has extracted. PDFs Zotero has not indexed are not searchable.

## Privacy

The API key and your library's contents are never logged. A failed Zotero call logs only the HTTP status and path. The Worker never sees your Access session token, only the signed assertion Access derives from it.
