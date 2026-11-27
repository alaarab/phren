# Obsidian

Phren can write its memory out as an Obsidian vault and bring an Obsidian vault's notes in as reference docs.

## Export a vault

Run `phren export vault <dir>` and open that directory as a vault in Obsidian.
Choose a directory separate from the primary Phren store, attached stores, and
your source checkout. The destination cannot contain a Phren store either.
Store setup already adds `.obsidian/` to the store's Git ignore rules.

```bash
phren export vault ~/phren-vault
phren export vault ~/phren-vault --project widgets --project team/tools --dry-run
```

The export includes all projects in the primary store and available subscribed
projects in attached stores by default. Repeat `--project <name>` to select
projects. Use `store/project` to disambiguate a shared project name. `--dry-run`
prints the number of project, finding, and fragment notes without writing the vault.
The export requires a readable store registry with valid project subscriptions.

Each project, finding, and indexed fragment has its own Markdown note. Finding
notes include frontmatter with the finding ID, project, type, lifecycle status,
and available dates. Findings from `FINDINGS.md`, topic archives, and `.older.md`
archives all appear, including superseded and retracted findings. Wikilinks connect
projects, findings, and fragments through the fragment index and finding lifecycle
references. Finding files resolve to regular files inside their selected project.
The export reports and skips paths that violate that boundary. Wikilinks in
reference docs, including imported Obsidian notes, contribute fragments linked
from their project note. Fragment links are scoped to indexed documents in
selected projects. A legacy manual link is exported when exactly one selected
store owns the document key. A finding also links to a fragment when it names
or explicitly annotates that fragment. Exact
lifecycle references take precedence over text prefixes. Unresolved lifecycle
references and source wikilinks appear as literal text. Source wikilinks keep
their heading target when that heading exists in the generated note.
Repository, file, line, commit, and symbol citations appear as text when available.

Run the command again to refresh the generated notes in place. The vault's
`.phren-vault.json` manifest tracks those notes so Phren can remove stale ones,
including when you narrow the project selection. Add personal notes and Obsidian
settings alongside the generated files. Use the Phren store for changes to the
original findings. A file whose bytes differ from both recorded hashes is
preserved, even if it has the generated marker. If the manifest is missing and
generated notes are present, or the manifest cannot be read or validated, restore
it from a backup or start with an empty vault directory.

An interrupted export can leave a lock. The next export reports the lock's PID,
host, and creation time. After confirming that the export has stopped, run
`phren export vault <dir> --force-unlock` by itself to remove the lock, then rerun
the export. The destination filesystem needs hard-link support to publish locks
and new notes atomically.

## Generated note contract

Every exported note begins with a YAML frontmatter document containing the
string property `phren: generated`. Importers should skip notes with this
property and value, even when the vault manifest is unavailable. The `kind`
property is one of `finding`, `fragment`, or `project`. A finding's `fid` is a
string when the source has an ID and `null` for a legacy finding without one.

The root file `.phren-vault.json` is UTF-8 JSON. Its version 1 format has a
numeric `version` set to `1`, a `files` object, and an optional `pending` object
while an export is being written. Both objects map vault-relative note filenames
to lowercase, 64-character SHA-256 hex digests of the complete file bytes.
`files` records the previous committed notes. `pending` records the intended
next notes so a refresh can recover after interruption. The exporter verifies
the file bytes against a recorded digest before replacing or deleting a note.

Keys are single basenames at the vault root, matching
`^(finding|fragment|project)-[a-z0-9_-]{1,200}\.md$`. They contain no directory
separators, and generated wikilinks use the basename without `.md`. Treat these
filenames as opaque. The `fid`, `project`, and `fragment` properties carry the
source identities.

## Import a vault

```sh
phren import vault ~/notes/MyVault --project demo --dry-run
phren import vault ~/notes/MyVault --project demo
```

Choose an existing project in the active profile or a subscribed project in an attached store. Use `store/project` if several stores share its name. Phren copies `.md` notes, including their YAML frontmatter, to `<project>/reference/obsidian/<vault-name>-<id>/`. It keeps the folder structure and adjusts names for portability, indexing, and collisions. The ID comes from the vault's resolved path. Moving the vault starts a separate import.

Import assumes you control the vault and store on your computer and that no hostile process swaps their files or directories during the run.

Imported notes are committed and synced with the store like other reference docs. Phren adds a `.gitattributes` rule under `reference/obsidian/` so Git preserves the original note bytes, including LF or CRLF line endings. `--dry-run` lists the notes that would be added and shows counts, including planned removals when used with `--prune`. A dry run leaves the import files untouched.

Phren skips `.obsidian/`, `.trash/`, `.git/`, `attachments/`, symlinks, and files other than Markdown notes. It skips notes whose frontmatter has `phren: generated` or whose bytes match the note's SHA-256 digest in `files` or `pending` in `.phren-vault.json`. A stale digest leaves the personal note eligible for import. Notes over 1 MiB are skipped and listed in the report.

Re-importing from the same path leaves identical notes untouched, updates changed notes, and lists previously imported notes missing from the vault. A retry uses the import inventory to recognize copies published before an interruption. `--prune` removes copies whose sources are missing and whose bytes still match the inventory. Phren reports and keeps copies that were edited in the store. Copies whose sources are still present but skipped are kept as well.

The normal reindex picks up wikilinks in new imports and when existing notes or findings change. It turns `[[Note]]`, `[[Note|alias]]`, and `[[Note#heading]]` in Markdown prose into links to the `note` fragment. The index records up to 128 distinct wikilink targets per document and keeps the existing finding and annotation links. The complete note stays in the store.
