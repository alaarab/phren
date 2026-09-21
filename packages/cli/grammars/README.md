# Bundled tree-sitter grammars

Prebuilt `web-tree-sitter` grammars for the `code` module. `parser.ts` loads
them from this directory at runtime; nothing is compiled on the user's machine
and nothing is downloaded after install.

Every file here was copied verbatim from a published npm package, except where
noted. `sha256` is recorded so a refresh can prove provenance.

| File | Language | Source package | sha256 |
| --- | --- | --- | --- |
| `tree-sitter-typescript.wasm` | TypeScript | `tree-sitter-typescript@0.23.2` | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tree-sitter-tsx.wasm` | TSX | `tree-sitter-typescript@0.23.2` | `79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8` |
| `tree-sitter-javascript.wasm` | JavaScript | `tree-sitter-javascript@0.25.0` | `5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240` |
| `tree-sitter-python.wasm` | Python | `tree-sitter-python@0.25.0` | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| `tree-sitter-rust.wasm` | Rust | `tree-sitter-rust@0.24.0` | `f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57` |
| `tree-sitter-go.wasm` | Go | `tree-sitter-go@0.25.0` | `9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7` |
| `tree-sitter-ruby.wasm` | Ruby | `tree-sitter-ruby@0.23.1` | `09a96427d7c72f0613ed470cd9812223fc4a91d6a9c025c0235cc6bd59ff96f4` |
| `tree-sitter-bash.wasm` | Bash | `tree-sitter-bash@0.25.1` | `8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a` |
| `tree-sitter-swift.wasm` | Swift | `tree-sitter-wasm@2.0.2` (`out/swift/`) | `3553bb4258b20fe3514c12a6e68d990036b9446e528283ec6ab79ede8854e791` |

## Notes and gaps

- The official `tree-sitter-swift` npm package does not ship a prebuilt
  `.wasm`. The Swift grammar here comes from
  [`tree-sitter-wasm@2.0.2`](https://www.npmjs.com/package/tree-sitter-wasm),
  which republishes grammars with a sigstore attestation next to each binary.
  It parses Swift 5 and 6 sources.
- `docs/code-index.md` also names JSON and Markdown-heading grammars. Stage 1
  ships the nine developer languages above; JSON and Markdown remain on the
  line-based fallback until a later stage adds them. No gap today: files of
  those types still get an outline through the fallback.
- Every grammar was verified with `web-tree-sitter@0.27.0` (`Language.load`
  followed by a parse) before being committed. The exact check lives in the
  module's parser tests.

## Adding a language

1. Copy the prebuilt `.wasm` here and add its row above.
2. Add a `LanguageSpec` to `../src/code/languages.ts` mapping the file
   extensions, the symbol query and the node kinds.
3. Add the file to the `files` list in `../package.json` if the directory is
   ever narrowed.
