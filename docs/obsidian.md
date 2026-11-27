## Import a vault

```sh
phren import vault ~/notes/MyVault --project demo --dry-run
phren import vault ~/notes/MyVault --project demo
```

Choose an existing project in the active profile. Use `store/project` if several stores share its name. Phren copies `.md` notes, including their YAML frontmatter, to `<project>/reference/obsidian/<vault-name>-<id>/`. It keeps the folder structure and adjusts names for portability, indexing, and collisions. The ID comes from the vault's resolved path. Moving the vault starts a separate import.

Import assumes you control the vault and store on your computer and that no hostile process swaps their files or directories during the run.

Imported notes are committed and synced with the store like other reference docs. `--dry-run` lists the notes that would be added and shows counts, including planned removals when used with `--prune`. A dry run leaves the notes and import inventory untouched.

Phren skips `.obsidian/`, `.trash/`, `.git/`, `attachments/`, symlinks, and files other than Markdown notes. It skips notes whose frontmatter has `phren: generated` or whose bytes match the note's SHA-256 digest in `files` or `pending` in `.phren-vault.json`. A stale digest leaves the personal note eligible for import. Notes over 1 MiB are skipped and listed in the report.

Re-importing from the same path leaves identical notes untouched, updates changed notes, and lists previously imported notes missing from the vault. A retry uses the import inventory to recognize copies published before an interruption. `--prune` removes copies whose sources are missing and whose bytes still match the inventory. Phren reports and keeps copies that were edited in the store. Copies whose sources are still present but skipped are kept as well.

The normal reindex picks up wikilinks in new imports and when existing notes or findings change. It turns `[[Note]]`, `[[Note|alias]]`, and `[[Note#heading]]` in Markdown prose into links to the `note` fragment. The index records up to 128 distinct wikilink targets per document and keeps the existing finding and annotation links. The complete note stays in the store.
