import * as fs from "node:fs";
import * as path from "node:path";
import { writeRootManifest } from "../../shared.js";

// All names and facts in this store are invented.
const PROJECTS = [
  ["velvetquay", "terminal compositor", "Glyph ferry uses a seven-cell gutter to prevent cursor clipping.", "Amber raster fences wait for the frame latch before recycling a texture.", "Copper atlas pages keep a two-pixel moat around every glyph."],
  ["mossrelay", "packet courier", "Parcel spool acknowledgements persist before the sender releases its lease.", "Willow retransmits use a thirteen-second jitter window after a lost receipt.", "Pebble routing rings reject packets with a reversed hop seal."],
  ["cinderloom", "schema migrator", "Basalt migrations acquire the schema bell before altering a column.", "Flint shadow tables copy rows in batches of exactly 320 records.", "Obsidian rollback journals retain the previous column codec until verification."],
  ["lilacforge", "asset compiler", "Petal bundles salt their digest with the shader dialect version.", "Violet linker manifests sort symbols by byte order before fingerprinting.", "Mauve dependency maps pin the source stamp before pruning an edge."],
  ["tidalnook", "queue scheduler", "Brine queue leases expire after 47 seconds without a heartbeat.", "Foam priority lanes reserve every fifth slot for delayed work.", "Kelp drain barriers wait for the last leased ticket before shutdown."],
  ["ochrevault", "encrypted journal", "Saffron journal keys rotate only after the footer seal is durable.", "Marigold recovery opens the twin header with the larger generation counter.", "Honey nonce blocks reserve 4096 values before writing ciphertext."],
  ["ferncradle", "dependency resolver", "Frond resolution breaks equal version ties using the lock digest.", "Spore cycle detection records the grey stack before descending into children.", "Rhizome mirrors validate the manifest seal before accepting a dependency."],
  ["silverhollow", "image tiler", "Prism tiles overlap by six pixels to avoid seams during resampling.", "Quartz mip chains stop when either dimension falls below three pixels.", "Opal tile caches evict the widest cold slab before shrinking the pool."],
  ["coralspindle", "search catalogue", "Anemone posting lists store position deltas as unsigned varints.", "Reef phrase matching requires adjacent offsets within the same field.", "Polyp shard maps promote a replica only after the watermark catches up."],
  ["plumharbor", "replica manager", "Damson replicas reject epochs older than the durable ballot.", "Sloe snapshot transfers verify the segment digest before acknowledging progress.", "Greengage quorum repair requires three matching ledger tails."],
  ["wrenkiln", "template engine", "Feather templates escape attribute values before applying indentation.", "Nest partials inherit locale through an explicit render scope.", "Wing interpolation treats an absent slot as an empty fragment."],
  ["dunepocket", "metric collector", "Sand histograms merge only when bucket boundaries are identical.", "Silt counters publish the interval start alongside each accumulated value.", "Loam sampling retains the earliest exemplar in each bucket."],
  ["hazelraft", "test sandbox", "Acorn sandboxes allocate a separate clock for every scenario.", "Catkin replay advances virtual time only at a recorded yield point.", "Cobnut isolation resets the descriptor ledger before reopening fixtures."],
  ["frostbobbin", "audio mixer", "Rime mixer voices fade across 96 samples before being reclaimed.", "Sleet resamplers preserve fractional phase when changing the input rate.", "Hoarfrost channel maps reject duplicate output pins during compilation."],
  ["russetcove", "archive packer", "Chestnut packs align each compressed block to a 512-byte boundary.", "Burr archive readers verify the trailing directory before mapping entries.", "Conker unpacking stages output beneath a disposable sibling directory."],
  ["global", "shared engineering notes", "Lantern incident notes put the recovery command before the diagnosis.", "Beacon review logs record the rejected alternative beside the chosen invariant.", "Wick handover cards include the next observable checkpoint."],
] as const;

const EVERYDAY = [
  "Give text room in the status panel; reserve one more line than you think is needed.",
  "Compare the line count between render passes to tell whether the project needs more room.",
  "A better trace should give an honest account of the retry boundary between handlers.",
  "Tell the project logger to include one more line when a buffer wraps.",
  "Think about the room between labels before choosing a better clipping rule.",
  "Compare both buffer lengths to give the line splitter an honest overflow estimate.",
  "The project inspector can tell which region has more room after compaction.",
  "A better checksum diagnostic prints the line offset between damaged blocks.",
  "Give each batch more room so adjacent records never share a cache line.",
  "Think through both counters and compare their deltas before reporting a stalled worker.",
];

const TAGS = ["pitfall", "bug", "context", "decision"] as const;
const ARCHIVED_BUG = "Ember fence repair clears the latch before retrying a stalled raster.";

export interface RecallFixture {
  phrenPath: string;
  projects: string[];
  retiredTexts: string[];
}

export interface RankingFixture extends RecallFixture {
  /** Each answer's project and the three newer distractor projects its prompt touches. */
  distractors: Record<string, string[]>;
}

function dayAgo(now: Date, days: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function buildRecallFixture(root: string): RecallFixture {
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) throw new Error("Recall fixture root must be empty");
  const phrenPath = path.join(root, "store");
  const projects = PROJECTS.map(([name]) => name);
  const retiredTexts: string[] = [];
  const now = new Date();
  const write = (file: string, text: string) => {
    const target = path.join(phrenPath, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text + "\n");
  };
  fs.mkdirSync(phrenPath);
  writeRootManifest(phrenPath, { version: 1, installMode: "shared", syncMode: "managed-git" });
  write("profiles/recall.yaml", `name: recall\nprojects:\n${projects.map(name => `  - ${name}`).join("\n")}`);

  for (const [pi, [name, domain, active, topic, older]] of PROJECTS.entries()) {
    const sparse = pi >= 12 && pi <= 14;
    if (name !== "global") {
      const checkout = path.join(root, "checkouts", name);
      fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
      write(`${name}/phren.project.yaml`, `sourcePath: ${JSON.stringify(checkout)}`);
    }
    const bullet = (text: string, tier: number, slot: number, age: number, status?: string) => {
      const fid = ((pi + 1) * 0x10000 + tier * 0x1000 + slot).toString(16).padStart(8, "0");
      let tag: string = slot % 10 === 0 ? TAGS[(pi + tier + Math.floor(slot / 10)) % TAGS.length] : "";
      if (slot === 0) tag = tier === 0 ? (pi % 4 === 0 ? TAGS[pi / 4] : "") : (pi % 5 === 0 ? "decision" : pi % 5 === 1 ? "pitfall" : "");
      if (pi === 0 && tier === 1 && slot === 1) tag = "bug";
      return `- ${tag ? `[${tag}] ` : ""}${text} <!-- fid:${fid} --> <!-- created: ${dayAgo(now, age)} -->${status ? ` <!-- phren:status "${status}" -->` : ""}`;
    };
    const document = (title: string, target: string, tier: number, count: number) => {
      const age = (i: number) => tier === 0 ? i % 30 : (tier === 1 ? 30 + i % 36 : 66 + i % 35);
      const lines = [`# ${name} ${title}`, ""];
      if (tier > 0) lines.push("<!-- phren:auto-topic slug=mechanics -->", "");
      const slots = Array.from({ length: count }, (_, i) => i).sort((a, b) => (tier === 0 ? age(a) - age(b) : age(b) - age(a)) || a - b);
      let lastAge = -1;
      for (const i of slots) {
        if (lastAge !== age(i)) lines.push(`## ${tier === 0 ? "" : "Archived "}${dayAgo(now, age(i))}`, "");
        lastAge = age(i);
        const text = i === 0 ? target : pi === 0 && tier === 1 && i === 1 ? ARCHIVED_BUG : `Checkpoint ${i}: ${EVERYDAY[(pi + i) % EVERYDAY.length]}`;
        lines.push(bullet(text, tier, i, age(i)), "");
      }
      for (const [i, status] of ["superseded", "retracted"].entries()) {
        const text = `${name} retired ${title.toLowerCase()} rule ${i}: bypass the ${domain} validation seal before accepting a stale segment.`;
        retiredTexts.push(text);
        lines.push(bullet(text, tier, 0xffe + i, age(0), status));
      }
      return lines.join("\n");
    };
    write(`${name}/FINDINGS.md`, document("Findings", active, 0, sparse ? 3 : 20));
    write(`${name}/reference/topics/mechanics.md`, document("Mechanics", topic, 1, pi === 0 ? 398 : sparse ? 6 : 12));
    write(`${name}/reference/topics/mechanics.older.md`, document("Older mechanics", older, 2, sparse ? 4 : 8));
    write(`${name}/summary.md`, `# ${name}\n\nAn experimental ${domain} with bounded buffers and explicit recovery checkpoints.`);
    write(`${name}/truths.md`, `# ${name} Truths\n\n## Truths\n\n- Preserve ${domain} invariants during recovery. _(added ${dayAgo(now, 3)})_`);
    write(`${name}/tasks.md`, `# ${name} tasks\n\n## Active\n\n- [ ] Inspect the ${domain} overflow report <!-- bid:${((pi + 1) * 0x10000).toString(16).padStart(8, "0")} rank:1 -->\n\n## Queue\n\n- [ ] Document the bounded recovery path\n\n## Done\n`);
    write(`${name}/AGENTS.md`, `# ${name}\n\nKeep ${domain} changes small and document recovery invariants.`);
  }
  return { phrenPath, projects, retiredTexts };
}

/**
 * The two score-before-date ranking cases run against this small store, so their dated headings and
 * distractor bullets stay clear of every other case. Each answer's latest findings heading is six days
 * old; its three distractors' are two, one and zero days old, and share only three invented words.
 * The distractors also mention the answer's terms in one-word lines, so those terms are not uniquely
 * rare and the distractors still clear the relevance floor.
 */
export function buildRankingFixture(root: string): RankingFixture {
  const phrenPath = path.join(root, "store");
  const projects = ["ferncradle", "velvetquay", "mossrelay", "cinderloom", "frostbobbin", "silverhollow", "coralspindle", "plumharbor"];
  const ANSWER_WORDS = ["frond", "lock", "digest", "version"];
  const ANSWER_SAMPLES = ["rime", "mixer", "sample", "reclaimed"];
  const now = new Date();
  fs.mkdirSync(phrenPath, { recursive: true });
  writeRootManifest(phrenPath, { version: 1, installMode: "shared", syncMode: "managed-git" });
  const write = (file: string, text: string) => {
    const target = path.join(phrenPath, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text + "\n");
  };
  write("profiles/recall.yaml", `name: recall\nprojects:\n${projects.map(name => `  - ${name}`).join("\n")}`);
  const project = (name: string, daysAgo: number, fid: string, text: string, mentions: string[] = []) => {
    const checkout = path.join(root, "checkouts", name);
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
    write(`${name}/phren.project.yaml`, `sourcePath: ${JSON.stringify(checkout)}`);
    const date = dayAgo(now, daysAgo);
    const legacy = mentions.map((word, i) => `- Legacy ${word} notes. <!-- fid:${fid.slice(0, 4)}0f0${i} --> <!-- created: ${date} -->`).join("\n");
    write(`${name}/FINDINGS.md`, `# ${name} Findings\n\n## ${date}\n\n- ${text} <!-- fid:${fid} --> <!-- created: ${date} -->\n${legacy}\n`);
  };
  project("ferncradle", 6, "00070000", "Frond resolution breaks equal version ties using the lock digest.");
  project("velvetquay", 0, "00010000", "Harbour logs record dreamwire quartzite helix readings before a compaction.", ANSWER_WORDS);
  project("mossrelay", 1, "00020000", "Harbour spool records dreamwire quartzite helix readings before a compaction.", ANSWER_WORDS);
  project("cinderloom", 2, "00030000", "Harbour schema records dreamwire quartzite helix readings before a compaction.", ANSWER_WORDS);
  project("frostbobbin", 6, "000e0000", "Rime mixer voices fade across 96 samples before being reclaimed.");
  project("silverhollow", 0, "00080000", "Harbour tile records marlstone gyre tessera readings before a compaction.", ANSWER_SAMPLES);
  project("coralspindle", 1, "00090000", "Harbour list records marlstone gyre tessera readings before a compaction.", ANSWER_SAMPLES);
  project("plumharbor", 2, "000a0000", "Harbour ledger records marlstone gyre tessera readings before a compaction.", ANSWER_SAMPLES);
  return {
    phrenPath,
    projects,
    retiredTexts: [],
    distractors: {
      ferncradle: ["velvetquay", "mossrelay", "cinderloom"],
      frostbobbin: ["silverhollow", "coralspindle", "plumharbor"],
    },
  };
}
