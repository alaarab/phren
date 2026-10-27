/**
 * The options a read-only command may take and still be auto-approved, and a
 * parser that reads a command's arguments the way the command itself does:
 * short clusters (`-rn`), a short option's value attached or next (`-n5`,
 * `-n 5`), `--opt=value` and `--opt value`, `-NUM` counts, `--` ending the
 * options (unless it is an option's value: `rg -e -- --pre=x`), and options
 * after operands. An option that isn't listed for the command makes the
 * command not auto-approvable: a command's writing or executing options
 * (`sort -o`, `rg --pre`, `git grep -O`) are left off, so a flag nobody
 * thought of asks instead of running (it replaced a deny-list that every
 * review found another flag missing from).
 */

export interface CommandSpec {
  /** Short options without a value. */
  flags?: string;
  /** Short options whose value is the rest of the cluster or the next argument. */
  valued?: string;
  /** Short options whose value, if any, is only the rest of the cluster (`-M50%`, `-uno`). */
  attached?: string;
  /** Long options without a value (names without `--`). */
  long?: string[];
  /** Long options whose value is after `=` or the next argument. */
  longValued?: string[];
  /** Long options whose value, if any, is only after `=` (`--color[=WHEN]`). */
  longOptional?: string[];
  /** `-NUM` is a count (`head -20`, `git log -5`). */
  numeric?: boolean;
  /** At most this many operands (`uniq IN OUT` writes OUT). */
  maxOperands?: number;
  /** A search tool: unless one of these options gives the pattern, the first operand is the pattern. */
  patternOptions?: string[];
  /** The first operand is not a path (jq's filter). */
  firstOperandNotPath?: boolean;
  /** No operand is a path (echo's words, tr's sets). */
  noPaths?: boolean;
  /** Options whose value is a file the command reads. */
  pathOptions?: string[];
  /** Every argument is an operand (echo, printf, test): nothing it takes writes or runs. */
  anyArgs?: boolean;
}

export interface ParsedOption { name: string; value?: string }
export interface ParsedArgs { options: ParsedOption[]; operands: string[] }

/** `args` read as `spec`'s command reads them, or null when any option is not on its list. */
export function parseOptions(args: string[], spec: CommandSpec): ParsedArgs | null {
  if (spec.anyArgs) return { options: [], operands: [...args] };
  const options: ParsedOption[] = [], operands: string[] = [];
  const has = (set: string | undefined, c: string) => !!set && set.includes(c);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { operands.push(...args.slice(i + 1)); break; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (spec.long?.includes(name)) { if (eq !== -1) return null; options.push({ name: `--${name}` }); continue; }
      if (spec.longOptional?.includes(name)) { options.push({ name: `--${name}`, ...(eq !== -1 ? { value: arg.slice(eq + 1) } : {}) }); continue; }
      if (spec.longValued?.includes(name)) {
        if (eq !== -1) { options.push({ name: `--${name}`, value: arg.slice(eq + 1) }); continue; }
        if (i + 1 >= args.length) return null;
        options.push({ name: `--${name}`, value: args[++i] });
        continue;
      }
      return null;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (spec.numeric && /^-\d+$/.test(arg)) { options.push({ name: "-NUM", value: arg.slice(1) }); continue; }
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j];
        if (has(spec.flags, c)) { options.push({ name: `-${c}` }); continue; }
        if (has(spec.attached, c)) { const rest = arg.slice(j + 1); options.push({ name: `-${c}`, ...(rest ? { value: rest } : {}) }); break; }
        if (has(spec.valued, c)) {
          const rest = arg.slice(j + 1);
          if (rest) { options.push({ name: `-${c}`, value: rest }); break; }
          if (i + 1 >= args.length) return null;
          options.push({ name: `-${c}`, value: args[++i] });
          break;
        }
        return null;
      }
      continue;
    }
    operands.push(arg);
  }
  if (spec.maxOperands !== undefined && operands.length > spec.maxOperands) return null;
  return { options, operands };
}

/** The arguments of a parsed command that name files it reads. */
export function parsedPaths(parsed: ParsedArgs, spec: CommandSpec): string[] {
  const paths = parsed.options.filter((o) => o.value !== undefined && spec.pathOptions?.includes(o.name)).map((o) => o.value!);
  if (spec.noPaths) return paths;
  let operands = parsed.operands;
  const patternGiven = spec.patternOptions && parsed.options.some((o) => spec.patternOptions!.includes(o.name));
  if ((spec.patternOptions && !patternGiven) || spec.firstOperandNotPath) operands = operands.slice(1);
  return [...paths, ...operands];
}

/** `table[key]` only when `key` is the table's own entry: a command or subcommand name is the model's text,
 * and `constructor` or `__proto__` must not find Object's members. */
export function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const GREP: CommandSpec = {
  flags: "EFGPiyvwxcLloqsbHhnTZzraIRU", valued: "ABCmefdD", numeric: true,
  long: ["extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp", "ignore-case", "no-ignore-case", "invert-match",
    "word-regexp", "line-regexp", "count", "files-with-matches", "files-without-match", "only-matching", "quiet", "silent",
    "no-messages", "byte-offset", "with-filename", "no-filename", "line-number", "initial-tab", "null", "null-data", "text",
    "recursive", "dereference-recursive", "line-buffered"],
  longValued: ["regexp", "file", "max-count", "after-context", "before-context", "context", "include", "exclude", "exclude-dir",
    "exclude-from", "binary-files", "devices", "directories", "label"],
  longOptional: ["color", "colour"],
  patternOptions: ["-e", "--regexp", "-f", "--file"], pathOptions: ["-f", "--file", "--exclude-from"],
};

/** Read-only commands and the options each may take unprompted. */
export const READ_ONLY_SPECS: Record<string, CommandSpec> = {
  ls: { flags: "1aAbBcCdfFgGhHiklLmnopqQrRsStuUvxX@eOT", valued: "Iw",
    long: ["all", "almost-all", "human-readable", "recursive", "reverse", "size", "directory", "classify", "inode",
      "numeric-uid-gid", "dereference", "group-directories-first", "full-time", "literal", "si"],
    longValued: ["ignore", "hide", "width", "sort", "time", "format", "time-style", "block-size", "tabsize", "indicator-style"],
    longOptional: ["color", "colour", "hyperlink"] },
  cat: { flags: "AbeEnstTuv", long: ["show-all", "number-nonblank", "show-ends", "number", "squeeze-blank", "show-tabs", "show-nonprinting"] },
  head: { flags: "qvz", valued: "nc", numeric: true, long: ["quiet", "silent", "verbose", "zero-terminated"], longValued: ["lines", "bytes"] },
  // No -f / -F: following never ends.
  tail: { flags: "qvzr", valued: "ncb", numeric: true, long: ["quiet", "silent", "verbose", "zero-terminated"], longValued: ["lines", "bytes"] },
  // No --files0-from here or on sort: the files it names come from a list no check here reads.
  wc: { flags: "clmwL", long: ["bytes", "chars", "lines", "words", "max-line-length"] },
  grep: GREP, egrep: GREP, fgrep: GREP,
  // No --pre (runs a program on every file) and no -z / --search-zip (runs decompressors).
  rg: { flags: "abcFHhiIlLnNopqsSuUvwx0.P", valued: "efgtTmABCMjrEd",
    long: ["hidden", "no-ignore", "no-ignore-vcs", "no-ignore-parent", "no-ignore-dot", "files", "count", "count-matches", "json",
      "line-number", "no-line-number", "column", "no-heading", "heading", "with-filename", "no-filename", "fixed-strings",
      "ignore-case", "smart-case", "case-sensitive", "word-regexp", "line-regexp", "invert-match", "files-with-matches",
      "files-without-match", "only-matching", "quiet", "follow", "vimgrep", "stats", "trim", "unrestricted", "text", "null",
      "no-messages", "sort-files", "multiline", "pcre2", "byte-offset", "no-config", "passthru", "glob-case-insensitive", "type-list"],
    longValued: ["regexp", "file", "glob", "iglob", "type", "type-not", "max-count", "max-depth", "max-filesize", "after-context",
      "before-context", "context", "context-separator", "field-match-separator", "replace", "sort", "sortr", "threads", "color",
      "colors", "encoding", "pre-glob", "type-add", "ignore-file", "path-separator", "max-columns"],
    patternOptions: ["-e", "--regexp", "-f", "--file"], pathOptions: ["-f", "--file", "--ignore-file"] },
  // No -o / --output (writes a file), -T (temporary files) or --compress-program (runs one).
  sort: { flags: "bdfgiMhnRrsuVcCmz", valued: "ktS",
    long: ["ignore-leading-blanks", "dictionary-order", "ignore-case", "general-numeric-sort", "ignore-nonprinting", "month-sort",
      "human-numeric-sort", "numeric-sort", "random-sort", "reverse", "version-sort", "check", "merge", "stable", "unique",
      "zero-terminated", "debug"],
    longValued: ["key", "field-separator", "buffer-size", "parallel", "random-source"],
    pathOptions: ["--random-source"] },
  // `uniq IN OUT` writes OUT.
  uniq: { flags: "cdDiuz", valued: "fsw", maxOperands: 1, long: ["count", "repeated", "ignore-case", "unique", "zero-terminated"],
    longValued: ["skip-fields", "skip-chars", "check-chars"], longOptional: ["all-repeated", "group"] },
  cut: { flags: "snz", valued: "bcdf", long: ["only-delimited", "complement", "zero-terminated"],
    longValued: ["bytes", "characters", "delimiter", "fields", "output-delimiter"] },
  tr: { flags: "cCdst", noPaths: true, long: ["complement", "delete", "squeeze-repeats", "truncate-set1"] },
  diff: { flags: "abBdeEilnNpqrsStTuwy", valued: "CUxXIFW",
    long: ["brief", "report-identical-files", "recursive", "new-file", "text", "ignore-case", "ignore-all-space",
      "ignore-space-change", "ignore-blank-lines", "side-by-side", "minimal", "strip-trailing-cr", "suppress-common-lines"],
    longValued: ["context", "exclude", "exclude-from", "ignore-matching-lines", "label", "width"], longOptional: ["unified", "color"],
    pathOptions: ["-X", "--exclude-from"] },
  cmp: { flags: "blsv", valued: "in", long: ["print-bytes", "verbose", "quiet", "silent"], longValued: ["ignore-initial", "bytes"] },
  echo: { anyArgs: true, noPaths: true },
  // printf -v assigns a variable (PATH among them): refused in shell-classify.ts.
  printf: { anyArgs: true, noPaths: true },
  test: { anyArgs: true, noPaths: true },
  "[": { anyArgs: true, noPaths: true },
  true: { anyArgs: true, noPaths: true },
  false: { anyArgs: true, noPaths: true },
  pwd: { flags: "LP", maxOperands: 0 },
  which: { flags: "as", noPaths: true },
  type: { flags: "afptP", noPaths: true },
  // No -C (compiles a magic file) and no -f (reads the names to test from a file).
  file: { flags: "bcdhiLNnprsvzZk0", valued: "mF", long: ["brief", "mime", "mime-type", "mime-encoding", "dereference",
    "no-dereference", "keep-going", "raw", "special-files", "uncompress"], pathOptions: ["-m"] },
  stat: { flags: "LtFlnqrsx", valued: "cf", long: ["dereference", "terse", "file-system"], longValued: ["format", "printf"] },
  du: { flags: "aAbcghHklLmPsSx0", valued: "dBtI", long: ["all", "apparent-size", "bytes", "total", "human-readable", "si",
    "dereference", "summarize", "one-file-system", "null", "count-links", "separate-dirs"],
    longValued: ["max-depth", "block-size", "threshold", "exclude", "exclude-from"], pathOptions: ["--exclude-from"] },
  df: { flags: "ahHiklmPTgx", valued: "tB", long: ["all", "human-readable", "si", "inodes", "local", "portability", "print-type", "total"],
    longValued: ["type", "exclude-type", "block-size"], longOptional: ["output"] },
  // No -o (writes its listing to a file).
  tree: { flags: "adfFgilnNpqrsuCDhJQSAXtvxUc", valued: "LIPH", long: ["noreport", "dirsfirst", "gitignore", "prune", "du", "si"],
    longValued: ["charset", "filelimit", "timefmt", "sort"] },
  basename: { flags: "az", valued: "s", noPaths: true, long: ["multiple", "zero"], longValued: ["suffix"] },
  dirname: { flags: "z", noPaths: true, long: ["zero"] },
  realpath: { flags: "esqLPmz", long: ["canonicalize-existing", "canonicalize-missing", "logical", "physical", "quiet", "strip",
    "no-symlinks", "zero"], longValued: ["relative-to", "relative-base"] },
  readlink: { flags: "fenmqsvz", long: ["canonicalize", "canonicalize-existing", "canonicalize-missing", "no-newline", "quiet",
    "silent", "verbose", "zero"] },
  // No -s / --set (sets the clock) and no -f (GNU: reads a file and echoes its lines); operands are
  // +FORMAT (a bare one would set the clock).
  date: { flags: "uRjn", valued: "dr", noPaths: true, long: ["utc", "universal", "rfc-email"], longValued: ["date", "reference"],
    longOptional: ["iso-8601", "rfc-3339"], pathOptions: ["-r", "--reference"] },
  // No --arg / --argjson / --slurpfile: they take two values.
  // No -f: a filter file can `import` data files no check here reads (the filter given inline is checked
  // for import and include in shell-classify.ts).
  jq: { flags: "rjacnsSeCMR", firstOperandNotPath: true, long: ["raw-output", "join-output", "ascii-output",
    "compact-output", "null-input", "slurp", "sort-keys", "exit-status", "color-output", "monochrome-output", "raw-input", "tab"],
    longValued: ["indent"] },
  nl: { flags: "p", valued: "bdfhilnsvw" },
  column: { flags: "txne", valued: "cso" },
  // No -c / --check: the files checked are named inside the sum file.
  sha256sum: { flags: "btz", long: ["binary", "text", "tag", "zero"] },
  md5sum: { flags: "btz", long: ["binary", "text", "tag", "zero"] },
  shasum: { flags: "btUp0", valued: "a", long: ["binary", "text", "portable", "tag"], longValued: ["algorithm"] },
  whoami: { maxOperands: 0 },
  uname: { flags: "amnrsvpio", maxOperands: 0 },
  // An operand would set the host name.
  hostname: { flags: "fsid", maxOperands: 0 },
  cd: { flags: "LP", maxOperands: 1 },
};

const GIT_DIFF_LONG = ["numstat", "shortstat", "summary", "name-only", "name-status", "patch-with-stat", "raw", "minimal",
  "patience", "histogram", "ignore-all-space", "ignore-space-change", "ignore-blank-lines", "ignore-space-at-eol", "check",
  "exit-code", "quiet", "no-color", "no-renames", "text", "binary", "full-index", "no-ext-diff", "patch", "no-patch",
  "function-context", "irreversible-delete", "cumulative", "no-prefix", "ita-invisible-in-index"];
const GIT_DIFF_OPTIONAL = ["stat", "dirstat", "color", "word-diff", "color-words", "find-renames", "find-copies", "relative",
  "abbrev", "color-moved", "ignore-submodules"];
const GIT_DIFF_VALUED = ["diff-filter", "src-prefix", "dst-prefix", "unified", "inter-hunk-context", "diff-algorithm", "anchored",
  "stat-width", "word-diff-regex"];
const GIT_LOG_LONG = ["oneline", "graph", "all", "reverse", "merges", "no-merges", "first-parent", "abbrev-commit", "follow",
  "left-right", "cherry-pick", "cherry-mark", "boundary", "topo-order", "date-order", "author-date-order", "source", "full-history",
  "simplify-by-decoration", "ancestry-path", "no-decorate", "remotes", "tags", "mailmap", "relative-date", "parents", "children",
  "no-abbrev-commit", "regexp-ignore-case", "all-match", "invert-grep", "use-mailmap"];
const GIT_LOG_VALUED = ["since", "after", "until", "before", "author", "committer", "grep", "max-count", "skip", "date", "min-parents",
  "max-parents", "encoding"];
const GIT_LOG_OPTIONAL = ["decorate", "format", "pretty", "branches", "no-walk", "notes"];

/** The read-only git subcommands and the options each may take. No `--output` anywhere (writes a file), no
 * `--ext-diff` or `--textconv` (run configured programs), no `git grep -O` (opens the matches in a program). */
export const GIT_SPECS: Record<string, CommandSpec> = {
  status: { flags: "sbvz", attached: "u", long: ["short", "branch", "long", "verbose", "show-stash", "ahead-behind",
    "no-ahead-behind", "renames", "no-renames", "no-column", "null"],
    longOptional: ["porcelain", "ignored", "untracked-files", "ignore-submodules", "find-renames", "column"] },
  diff: { flags: "pusRawbBzW", valued: "SGlO", attached: "UMCBX", long: [...GIT_DIFF_LONG, "cached", "staged", "no-index", "merge-base"],
    longOptional: GIT_DIFF_OPTIONAL, longValued: GIT_DIFF_VALUED, pathOptions: ["-O"] },
  log: { flags: "pqsuzw", valued: "nSGL", attached: "UMC", numeric: true, long: [...GIT_LOG_LONG, ...GIT_DIFF_LONG],
    longOptional: [...GIT_LOG_OPTIONAL, ...GIT_DIFF_OPTIONAL], longValued: [...GIT_LOG_VALUED, ...GIT_DIFF_VALUED] },
  show: { flags: "pqsuzw", valued: "nSG", attached: "UMC", numeric: true, long: [...GIT_LOG_LONG, ...GIT_DIFF_LONG],
    longOptional: [...GIT_LOG_OPTIONAL, ...GIT_DIFF_OPTIONAL], longValued: [...GIT_LOG_VALUED, ...GIT_DIFF_VALUED] },
  "rev-parse": { flags: "q", long: ["verify", "quiet", "show-toplevel", "git-dir", "git-common-dir", "absolute-git-dir",
    "is-inside-work-tree", "is-inside-git-dir", "is-bare-repository", "is-shallow-repository", "show-prefix", "show-cdup",
    "symbolic", "symbolic-full-name", "all", "local-env-vars", "show-superproject-working-tree"],
    longOptional: ["abbrev-ref", "short", "branches", "tags", "remotes"], longValued: ["git-path", "since", "until"] },
  "ls-files": { flags: "cdmoiskutvfz", valued: "xX", long: ["cached", "deleted", "modified", "others", "ignored", "stage", "killed",
    "unmerged", "directory", "no-empty-directory", "exclude-standard", "full-name", "recurse-submodules", "error-unmatch",
    "eol", "deduplicate", "sparse"], longOptional: ["abbrev"], longValued: ["exclude", "exclude-from", "exclude-per-directory",
    "with-tree", "format"], pathOptions: ["-X", "--exclude-from"] },
  blame: { flags: "bclstfnpwe", valued: "LS", attached: "MC", long: ["porcelain", "line-porcelain", "incremental", "root",
    "show-stats", "show-name", "show-number", "show-email", "reverse", "first-parent", "minimal"],
    longValued: ["date", "ignore-rev", "ignore-revs-file", "contents", "abbrev"], longOptional: ["color-lines", "color-by-age"],
    pathOptions: ["-S", "--ignore-revs-file", "--contents"] },
  grep: { flags: "aIiwvhHlLcnbzFEGPWqro", valued: "efABCm", numeric: true,
    long: ["cached", "untracked", "no-index", "no-exclude-standard", "exclude-standard", "recurse-submodules", "text",
      "ignore-case", "word-regexp", "invert-match", "full-name", "extended-regexp", "basic-regexp", "perl-regexp",
      "fixed-strings", "line-number", "column", "files-with-matches", "name-only", "files-without-match", "count", "no-color",
      "break", "heading", "show-function", "function-context", "quiet", "all-match", "and", "or", "not", "only-matching", "null"],
    longValued: ["max-depth", "threads", "after-context", "before-context", "context", "max-count"], longOptional: ["color"],
    patternOptions: ["-e", "-f"], pathOptions: ["-f"] },
  describe: { long: ["tags", "all", "always", "long", "exact-match", "contains", "first-parent"],
    longOptional: ["abbrev", "dirty", "broken"], longValued: ["candidates", "match", "exclude"] },
  shortlog: { flags: "nsec", long: ["numbered", "summary", "email", "committer"], longValued: ["group"], longOptional: ["format"] },
};

/** git's own options before the subcommand that keep it `git <subcommand>` (no -c, -C, --git-dir, --exec-path…). */
export const GIT_GLOBAL_SAFE = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"]);

/** find's tests and actions that only test or print, with the number of arguments each takes. Not -exec,
 * -execdir, -ok, -okdir, -delete or -fprint* (run programs, delete or write files). */
export const FIND_PRIMARIES: Record<string, number> = {
  "-print": 0, "-print0": 0, "-prune": 0, "-empty": 0, "-true": 0, "-false": 0, "-o": 0, "-or": 0, "-a": 0, "-and": 0,
  "-not": 0, "!": 0, "(": 0, ")": 0, "-depth": 0, "-xdev": 0, "-mount": 0, "-follow": 0, "-ls": 0, "-quit": 0,
  "-nouser": 0, "-nogroup": 0, "-readable": 0, "-writable": 0, "-executable": 0, "-d": 0, "-x": 0,
  "-name": 1, "-iname": 1, "-path": 1, "-ipath": 1, "-wholename": 1, "-iwholename": 1, "-regex": 1, "-iregex": 1,
  "-type": 1, "-xtype": 1, "-maxdepth": 1, "-mindepth": 1, "-size": 1, "-mtime": 1, "-mmin": 1, "-atime": 1, "-amin": 1,
  "-ctime": 1, "-cmin": 1, "-newer": 1, "-anewer": 1, "-cnewer": 1, "-newermt": 1, "-user": 1, "-group": 1, "-perm": 1,
  "-links": 1, "-inum": 1, "-samefile": 1, "-uid": 1, "-gid": 1, "-lname": 1, "-ilname": 1, "-printf": 1, "-regextype": 1, "-fstype": 1,
};

/** find's start paths, or null when its expression has anything but FIND_PRIMARIES. */
export function parseFind(args: string[]): string[] | null {
  let i = 0;
  while (i < args.length && /^-[HLP]+$/.test(args[i])) i++;
  const paths: string[] = [];
  while (i < args.length && !args[i].startsWith("-") && args[i] !== "(" && args[i] !== "!") paths.push(args[i++]);
  while (i < args.length) {
    const arity = own(FIND_PRIMARIES, args[i]);
    if (arity === undefined || (arity > 0 && i + arity >= args.length)) return null;
    i += 1 + arity;
  }
  return paths;
}

/** sed's options: -i (edits in place) and -f (a script this reader can't see) are not on the list. */
export const SED_SPEC: CommandSpec = { flags: "nErsuz", valued: "e", long: ["quiet", "silent", "regexp-extended", "posix",
  "separate", "unbuffered", "null-data", "sandbox", "debug"], longValued: ["expression", "line-length"] };

/** sed commands that only print or edit the stream (no w/W write a file, e runs one, r/R read one in). */
const SED_PLAIN = "pdDgGhHxnNPlzF=";

/**
 * Whether a sed script only prints or edits the stream: each command, after its addresses (`1`, `$`,
 * `/re/`, `1,5`, `0~2`, `!`), is one of SED_PLAIN, a block, a label or branch, q/Q, a/i/c text, y, or
 * s/// whose flags neither write (w) nor run (e). Anything else, w, W, e, r and R among them, is not.
 */
export function sedScriptIsPlain(script: string): boolean {
  const s = script;
  let i = 0;
  const regex = (delim: string): boolean => {
    for (; i < s.length; i++) {
      if (s[i] === "\\") { i++; continue; }
      if (s[i] === delim) { i++; return true; }
    }
    return false;
  };
  const address = (): boolean => {
    if (/[0-9]/.test(s[i] ?? "")) { while (/[0-9~]/.test(s[i] ?? "")) i++; return true; }
    if (s[i] === "$") { i++; return true; }
    if (s[i] === "/") { i++; if (!regex("/")) return false; while (s[i] === "I" || s[i] === "M") i++; return true; }
    if (s[i] === "\\" && s[i + 1]) { const delim = s[i + 1]; i += 2; if (!regex(delim)) return false; while (s[i] === "I" || s[i] === "M") i++; return true; }
    return true;
  };
  const skipSpace = () => { while (s[i] === " " || s[i] === "\t") i++; };
  const toLineEnd = (stopAtSemicolon: boolean) => { while (i < s.length && s[i] !== "\n" && !(stopAtSemicolon && s[i] === ";")) i++; };
  while (i < s.length) {
    while (i < s.length && /[\s;]/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    if (!address()) return false;
    if (s[i] === "," && i !== start) { i++; skipSpace(); if (s[i] === "+" || s[i] === "~") i++; if (!address()) return false; }
    skipSpace();
    while (s[i] === "!") { i++; skipSpace(); }
    const c = s[i++];
    if (c === undefined) return false;
    if (c === "{" || c === "}") continue;
    if (c === "#") { toLineEnd(false); continue; }
    if (c === ":" || c === "b" || c === "t" || c === "T") { toLineEnd(true); continue; }
    if (c === "q" || c === "Q") { skipSpace(); while (/[0-9]/.test(s[i] ?? "")) i++; continue; }
    if (SED_PLAIN.includes(c)) continue;
    // Text to append, insert or change: printed, never a file.
    if (c === "a" || c === "i" || c === "c") { toLineEnd(false); continue; }
    if (c === "y" || c === "s") {
      const delim = s[i++];
      if (!delim || delim === "\n" || delim === "\\") return false;
      if (!regex(delim) || !regex(delim)) return false;
      if (c === "s") { while (/[gpiImM0-9]/.test(s[i] ?? "")) i++; }
      // A flag left over (w writes a file, e runs the pattern space) or anything glued on.
      skipSpace();
      if (i < s.length && !/[;\n}]/.test(s[i])) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** sed's input files, or null when it edits in place, reads a script file, or its script writes, runs or reads a file. */
export function parseSed(args: string[]): string[] | null {
  const parsed = parseOptions(args, SED_SPEC);
  if (!parsed) return null;
  const given = parsed.options.filter((o) => o.name === "-e" || o.name === "--expression").map((o) => o.value!);
  const scripts = given.length ? given : parsed.operands.slice(0, 1);
  if (!scripts.length || !scripts.every(sedScriptIsPlain)) return null;
  return given.length ? parsed.operands : parsed.operands.slice(1);
}
