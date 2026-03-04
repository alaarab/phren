---
name: humanize
description: Scan everything that changed and fix AI-sounding text. Word kill list, structural patterns, code tells.
---
# /humanize - Kill the AI Voice

Scan everything that changed. If it reads like a chatbot wrote it, fix it.

Writing human is the default. But when agents have been loose, or you inherited AI-generated text, run this to clean house.

## Phase 1: Scan

Run all scans against changed files. Use `git diff --name-only` (or `git diff HEAD --name-only` if staged) to get the file list.

```bash
FILES=$(git diff --name-only 2>/dev/null || git diff HEAD --name-only 2>/dev/null)

# Em dashes (the #1 tell)
echo "$FILES" | xargs grep -l $'\xe2\x80\x94' 2>/dev/null

# Buzzwords (extended list)
echo "$FILES" | xargs grep -il 'leverag\|robust\|seamless\|comprehensive\|streamlin\|elegant\|intuitive\|cutting-edge\|delve\|harness\|facilitat\|empower\|paradigm\|furthermore\|moreover\|showcas\|foster\|pivot\|transparen\|innovati\|groundbreak\|revoluti\|holistic\|versatile\|profound\|meticulous\|vibrant\|tapestry\|landscape\|journey\|ecosystem\|cornerstone\|beacon\|symphony\|testament\|realm\|plethora\|myriad\|underscor\|exemplif\|transcend\|intertwine\|reimagin\|captivat\|resonat\|elevat\|supercharg\|unleash\|unlock the\|multifacet\|intricat\|nuanc' 2>/dev/null

# Hedging and filler phrases
echo "$FILES" | xargs grep -il "it's worth noting\|it's important to note\|it should be noted\|one must consider\|generally speaking\|in today's\|at the end of the day\|at its core\|not only.*but also\|pave the way\|at the forefront\|push the boundaries\|bridging the gap\|in order to\|due to the fact\|has the ability to\|it is evident that" 2>/dev/null

# Chatbot artifacts
echo "$FILES" | xargs grep -il 'I hope this helps\|Let me know if\|Great question\|Excellent point\|certainly\!' 2>/dev/null

# Code: obvious comments
echo "$FILES" | xargs grep -n '^\s*//\s*\(Initialize\|Create\|Set up\|Handle\|Process\|Return the\|Check if\|Validate\|Ensure\|Update the\|Get the\|Loop through\|Iterate over\)' 2>/dev/null

# Unicode: smart quotes, zero-width chars
echo "$FILES" | xargs grep -Pl '[\x{200B}\x{200C}\x{200D}\x{2018}\x{2019}\x{201C}\x{201D}]' 2>/dev/null
```

Read each flagged file. Fix every hit.

## Phase 2: The Word Kill List

These words appear 10x-269x more often in AI text than human text. If you see them, rewrite the sentence.

### Tier 1: Nuke on sight (highest AI signal)
delve, leverage, robust, seamless, comprehensive, streamlined, foster, showcase, pivotal, crucial, tapestry, landscape (abstract), journey, multifaceted, intricate, nuanced, harness, paradigm, ecosystem, empower, facilitate, testament, beacon, symphony, cornerstone, myriad, plethora, realm

### Tier 2: Almost always filler
furthermore, moreover, additionally, consequently, nevertheless, nonetheless, subsequently, accordingly, hence, thus, notably, significantly, ultimately, essentially, crucially

### Tier 3: Inflated verbs
exemplify, underscore, transcend, intertwine, reimagine, captivate, resonate, elevate, revolutionize, orchestrate, supercharge, unleash, unlock, illuminate, elucidate

### Tier 4: Fake-impressive adjectives
groundbreaking, cutting-edge, transformative, innovative, holistic, versatile, exceptional, meticulous, vibrant, profound, bespoke, whimsical, indelible, commendable, compelling

### Quick replacements

| Kill | Use instead |
|------|------------|
| leveraging | using |
| robust | solid, or delete |
| seamless / seamlessly | smooth, or delete |
| comprehensive | (be specific) |
| streamlined | simple |
| furthermore / moreover | also, and |
| it's worth noting | (just say it) |
| in order to | to |
| due to the fact that | because |
| has the ability to | can |
| at this point in time | now |
| delve / delving | look at, dig into |
| harness | use |
| facilitate | help |
| empower | let, allow |
| serves as a / stands as | is |
| features / offers / boasts | has |

## Phase 3: Structural Patterns

Word lists catch the obvious stuff. These structural patterns are what actually trips detectors.

### Sentence rhythm
AI writes sentences that all land between 14-22 words. Same length, same cadence, same structure. Humans don't do that. Short sentence. Then a longer one that winds around and picks up a few subordinate clauses. Then another short one. Mix it up.

**Check:** Read a paragraph aloud. If every sentence has the same beat, rewrite it with varied lengths.

### Rule of three
AI loves tricolons: "fast, efficient, and reliable." Three adjectives. Three bullet points. Three examples. Every time. Humans sometimes list two things. Sometimes four. Sometimes one.

**Check:** If you see "X, Y, and Z" patterns more than once per section, break some of them.

### Bolded-header bullet lists
Every AI response does this:
- **Thing one:** explanation of thing one
- **Thing two:** explanation of thing two

Humans write prose. Or if they do use bullets, they don't bold-label every single one. Convert some to sentences. Drop the bold headers.

### Participial phrase openers
"Showcasing the...", "Highlighting the...", "Fostering a..." - sentences starting with -ing verbs. AI uses these 2-5x more than humans. Rewrite: put the subject first.

### Copula avoidance
AI says "serves as a gateway" or "stands as a testament" or "marks the beginning" when it means "is." Just say "is."

### Negative parallelism
"Not only X, but also Y" and "It's not just about X, it's about Y." These are AI templates. Rewrite or cut.

### Uniform paragraph length
If every paragraph is roughly the same size, that's a tell. Humans write paragraphs of different lengths. Some are one sentence.

### Excessive positivity
AI doesn't criticize. Everything is "exciting," the future is "bright," challenges are "opportunities." If the text never acknowledges a downside or tradeoff, add some honesty.

### Absent contractions
"We have" instead of "we've." "It is" instead of "it's." "Do not" instead of "don't." Humans use contractions in informal and semi-formal writing. If the text has zero contractions, add some.

## Phase 4: Code Patterns

### Obvious comments (the biggest code tell)
Comments that restate the code. Delete them.

```ts
// BAD: AI always does this
// Initialize the user service
const userService = new UserService();

// Loop through the users
for (const user of users) {

// Check if the user is active
if (user.isActive) {

// Return the result
return result;

// GOOD: explains WHY
// Separate instance per request to avoid shared state leaks
const userService = new UserService();

// BEST: no comment needed when the code is clear
const userService = new UserService();
```

Comment prefixes that almost always mean "delete this comment": Initialize, Create, Set up, Handle, Process, Return, Check, Validate, Ensure, Update, Get, Loop, Iterate, Define, Declare, Import, Export, Call, Invoke, Assign.

### Over-documented trivial functions
If TypeScript types explain it, the JSDoc is noise.

```ts
// DELETE: types say everything
/** Returns the sum of two numbers */
function add(a: number, b: number): number { return a + b; }

// KEEP: adds real context
/** Falls back to email prefix if display name is empty */
function getName(): string { ... }
```

### Hyper-descriptive identifiers
AI averages 18.7 chars per identifier. Humans average 8.3. If you see `activeRegisteredUserQuantity`, rename it to `userCount`. If you see `inputStringValidationStatusFlag`, it's `isValid`.

### Over-engineering
- Factory patterns for a single product type
- Builder patterns for objects with 3 fields
- Wrapper functions that just forward arguments
- try-catch on code that can't throw
- Defensive null checks for values that are never null (check the types)
- Excessive interface/type definitions for one-off use

### Commit messages
Conventional Commits format (`feat:`, `chore:`, `fix:`, `refactor:`) is an AI tell. Real commits just say what happened.

| AI | Human |
|----|-------|
| `feat: add user authentication system` | `add login with JWT` |
| `chore: update dependencies` | `bump express to 5.1` |
| `fix: resolve null pointer exception in user service` | `fix crash when user has no profile` |
| `refactor: extract helper functions for better maintainability` | `pull search logic into its own function` |

No colons after a category prefix. No passive constructions. Say the actual thing that changed.

## Phase 5: Formatting and Unicode

### Em dashes
The most stubborn AI signature. Replace with commas, parentheses, colons, or rewrite the sentence. One em dash per page is fine. Three in a paragraph is AI.

### Smart quotes and special chars
Replace curly quotes with straight quotes. Replace the single-char ellipsis with three dots. Remove zero-width spaces (U+200B, U+200C, U+200D).

### Title Case in Headings
AI capitalizes Every Important Word in headings. Use sentence case instead: "How to set up authentication" not "How to Set Up Authentication."

### Excessive bold
AI bolds key phrases mechanically. Use bold sparingly for actual emphasis, not as a structural pattern.

## Phase 6: Self-Audit

After fixing everything, read the text one more time. Ask:

1. Does every paragraph sound the same? (rhythm problem)
2. Is every sentence roughly the same length? (burstiness problem)
3. Does it sound like it could have come from any AI session? (voice problem)
4. Would I believe a person wrote this? (the real test)

If the answer to #3 is yes, the fix isn't more word replacement. It's rewriting with actual voice: opinions, specific details, varied structure, and the occasional short sentence that just lands.

## Don't Overdo It

Not every instance of "however" is AI slop. Not every em dash needs to die. Context matters. The goal is text that sounds like a person wrote it, not text that's been through a mechanical filter.

Read the output aloud. If it sounds natural, it's done.
