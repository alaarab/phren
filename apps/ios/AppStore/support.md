# phren for iOS — Support

<!--
Publish to https://alaarab.github.io/phren/support.html before submitting.
App Store Connect requires a support URL and App Review will open it. A
page that 404s is a rejection; a page with a real answer or two is fine.
-->

## Getting started

phren for iOS connects to your coding agents and project memory. Agents and
terminals use SSH and Phren Hook on your computers; they work without a GitHub
sign-in. To sync memory, connect a phren store — a GitHub repository containing
a `phren.root.yaml` file.

If you don't have one yet, install the CLI and create one:

```
npm install -g @phren/cli
phren init
```

Then push that store to a GitHub repository and connect the app to it.

## Connecting memory

Open Projects or Settings → Connect memory. GitHub is needed only for syncing
your memory repositories; you can dismiss setup and continue using Agents.

1. Create a fine-grained personal access token at
   **github.com/settings/personal-access-tokens/new**
2. Under **Repository access**, choose **Only select repositories** and
   pick your phren store repository
3. Under **Permissions → Repository permissions**, set
   **Contents: Read and write** and **Metadata: Read**
4. Paste the token into the app

Your token is stored only in your device's Keychain and is sent only to
GitHub.

## Common problems

**Agent chat or terminals cannot connect.**
Keep Tailscale connected on the phone and computer. Install Phren Hook on each
computer with `npx --yes @phren/cli@0.2.14 bridge install`, then run
`npx --yes @phren/cli@0.2.14 bridge doctor`. Add the computer in Agents and
authorize its device SSH key. Moshi is not required. See the
[Phren Hook guide](https://alaarab.github.io/phren/phren-hook.html).

**A web preview has no styles or scripts.**
Check that the development server serves its CSS and JavaScript URLs without
errors. Restart or redeploy its HTML and asset manifest together after an app
build. Relative assets and WebSockets work over Phren's SSH preview; an app
that hardcodes another origin may need its public/base URL configured.

**The input token count is much larger than the message I typed.**
The latest response can include conversation context, instructions, and tools.
The usage details distinguish reused cached input from uncached input. They
show the latest model response, not an account quota or the text length of your
latest message.

**"Only public repositories are listed" / my store isn't in the picker.**
Your token doesn't have access to the repository. GitHub deliberately
returns "not found" rather than "forbidden" for private repositories a
token can't read, so this looks like the repo doesn't exist. Edit the
token and make sure your store repository is included under Repository
access.

**Everything is read-only / I can't add anything.**
Your token has read access but not write. Set **Contents: Read and
write** on the token, then pull to refresh in the app — permissions are
re-checked on refresh.

**A note or task I added hasn't appeared on my other machines.**
Changes are queued locally and pushed when the app is open. Open the app
and give it a few seconds. **Settings → Recent captures** shows each
capture and whether it has synced yet. If something failed permanently,
it appears under **Settings → Needs attention**, where you can retry or
discard it.

**Siri added a task but I don't know where it went.**
**Settings → Recent captures** shows the destination of every capture.
To stop it choosing for you, set a default under **Settings → Quick
capture**, or leave it on **Always ask** and Siri will ask each time.

**Siri opens the wrong app when I say "phren".**
Say **"Add a phren task"** rather than "add a task to phren" — the latter
is a phrase Reminders also claims. Running the shortcut once by hand from
the Shortcuts app significantly improves Siri's recognition afterwards.
You can also bind **phren: Add Task** to the Action Button.

## Contact

**ala@alaarab.com**

Bug reports and feature requests are welcome as GitHub issues:
https://github.com/alaarab/phren/issues
