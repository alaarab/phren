# linkedin post — phren

---

## the post

i was building a framework for generating audio plugins on demand. claude didn't think it was possible. so i taught it. then the chat ended and i had to teach it again. and again.

every new chat i was burning tokens re-explaining my own project. eventually got annoyed enough to build phren.

phren is a memory layer for ai agents. one command:

`npx @phren/cli init`

point it at a repo and boom, claude remembers. so does copilot, cursor, codex. same memory, all four.

your data lives as plain markdown in your own git repo. imagine that, actually owning your data in 2026. lol.

the vscode extension is where it really clicks. you get a fragment graph that shows how your knowledge connects across projects, a sidebar to manage memories, supersede the wrong ones, retract the obsolete ones, and watch trust scores decay over time so old advice doesn't haunt you forever.

spin up a team store and your whole crew shares the same memory. one repo for the company, separate repos per team, profiles per machine. everyone's agents get smarter together.

open source, mit. cli is `@phren/cli` on npm. vscode extension is `phren` on the marketplace. github and docs in the comments.

try it. break it. tell me.

---

## what to put in the first comment

> repo: https://github.com/alaarab/phren
> docs: https://alaarab.github.io/phren/
> vscode: https://marketplace.visualstudio.com/items?itemName=alaarab.phren-vscode
> npm: https://www.npmjs.com/package/@phren/cli

---

## visual

use `docs/phren-graph-walk.gif`. it's already in the repo, it's the fragment graph in motion, and it's the single most "what does this thing actually do" asset you have. linkedin auto-plays gifs in the feed, which is the whole point.

if you want a second image as a carousel, screenshot the vscode sidebar with a memory open and the supersede/retract buttons visible. that one shot makes "manage your memories" concrete.

---

## notes

- team stuff is back, framed as a payoff ("everyone's agents get smarter together") instead of a feature dump.
- vscode + fragment graph + supersede/retract is now its own beat in the post, not a throwaway line.
- github and docs links go in the first comment, not the body. linkedin throttles posts with outbound links.
- still zero em dashes.
- swap the audio plugin example for whatever real project you want associated with this post. that opener is doing most of the work.
