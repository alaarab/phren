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

a 20-second branded reel that strings together: cold open with the mascot, the pain, the install, claude remembering, supersede/retract, team stores, "own your data", cta with the wordmark and install command.

built as code so it stays in sync with the brand and you can re-render whenever the message shifts.

```bash
# one-time setup
pnpm exec playwright install chromium     # if you haven't yet
brew install ffmpeg                       # or: apt install ffmpeg

# render
pnpm record:post-reel                     # square 1080x1080 mp4 + gif
pnpm record:post-reel -- --portrait       # 1080x1350 (linkedin portrait)
pnpm record:post-reel -- --duration=15    # tighter cut
```

outputs land in `dist/post-reel/post-reel.mp4` and `dist/post-reel/post-reel.gif`.

preview the reel live (no recording, just loops in your browser):

```bash
# from repo root
python3 -m http.server 4173 --directory docs
# then open http://localhost:4173/motion-lab/post-reel.html
```

mp4 outperforms gif in the linkedin feed (better quality, autoplays muted), but the gif is handy for embedding in the readme or replying to comments. fallback if you want zero effort: `docs/phren-graph-walk.gif` is already in the repo and works on its own.

---

## notes

- team stuff is back, framed as a payoff ("everyone's agents get smarter together") instead of a feature dump.
- vscode + fragment graph + supersede/retract is now its own beat in the post, not a throwaway line.
- github and docs links go in the first comment, not the body. linkedin throttles posts with outbound links.
- still zero em dashes.
- swap the audio plugin example for whatever real project you want associated with this post. that opener is doing most of the work.
