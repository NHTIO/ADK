// Node keyword-search index for the portable harness. VitePress emits its REAL local-search MiniSearch index
// (the exact one the docs searchbox uses) to disk at build time as a chunk:
//   docs/.vitepress/dist/assets/chunks/@localSearchIndexroot.<hash>.js
// which is `const e='<MiniSearch JSON>';export{e as default};`. We load that emitted JSON and rehydrate it
// with the SAME MINISEARCH_OPTIONS the agent uses, giving Node keyword search that is byte-faithful to the
// browser searchbox — no rebuild from the raw .md needed. Feed the result to
// agent_keyword_search._setKeywordIndex(). Requires a prior `docs:build` (or `document`) so the chunk exists.
import { resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Must match agent_keyword_search.ts MINISEARCH_OPTIONS verbatim (VitePress VPLocalSearchBox parity).
const MINISEARCH_OPTIONS = {
  fields: ['title', 'titles', 'text'],
  storeFields: ['title', 'titles'],
  searchOptions: { fuzzy: 0.2, prefix: true, boost: { title: 4, text: 2, titles: 1 } },
}

const CHUNKS_DIR = 'docs/.vitepress/dist/assets/chunks'

/**
 * Build the MiniSearch index from VitePress's emitted local-search chunk. Returns an object with `search(q)`
 * — the exact shape agent_keyword_search.loadIndex() expects. Throws a clear error if the chunk is absent
 * (run `pnpm docs:build` first).
 */
export async function buildNodeKeywordIndex(
  repoRoot: string
): Promise<{ search: (q: string) => Array<{ id: string; title?: string; titles?: string[] }> }> {
  const dir = resolve(repoRoot, CHUNKS_DIR)
  let file: string | undefined
  try {
    file = readdirSync(dir).find((f) => f.startsWith('@localSearchIndexroot') && f.endsWith('.js'))
  } catch {
    throw new Error(`keyword index dir not found: ${dir} — run \`pnpm docs:build\` first`)
  }
  if (!file) {
    throw new Error(
      `@localSearchIndexroot chunk not found in ${dir} — run \`pnpm docs:build\` first`
    )
  }
  // The chunk is `const e='<json>';export{e as default};` — importing it yields the raw JSON string.
  const chunkModule = await import(pathToFileURL(resolve(dir, file)).href)
  const raw = chunkModule.default as string
  const { default: MiniSearch } = (await import('minisearch')) as {
    default: {
      loadJSON: (
        json: string,
        opts: typeof MINISEARCH_OPTIONS
      ) => { search: (q: string) => Array<{ id: string; title?: string; titles?: string[] }> }
    }
  }
  return MiniSearch.loadJSON(raw, MINISEARCH_OPTIONS)
}
