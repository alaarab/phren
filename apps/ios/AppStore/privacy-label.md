# App Privacy answers (the "nutrition label")

App Store Connect → your app → **App Privacy**. These answers are a legal
declaration about what **you, the developer**, collect. Data the user
sends to their *own* GitHub repository is not collected by you.

The distinction that matters: "collect" means transmitted off device **in
a way you or your third-party partners can access**. This app has no
developer-operated server and no analytics or telemetry SDKs.

---

## The top-level question

> Do you or your third-party partners collect data from this app?

**No — "Data Not Collected".**

Justification, if ever challenged:

- No analytics, crash reporting, or telemetry framework is linked. SwiftNIO
  SSH and Swift Crypto implement optional direct computer connections.
- Store access goes directly to GitHub. Optional live status goes directly
  to a computer the user adds, through authenticated SSH to its Moshi hook.
  The developer receives neither store content nor live session metadata.
- The GitHub token is stored in the device Keychain and is never
  transmitted anywhere except to GitHub as an authorization header.
- Speech is transcribed by Apple's Speech framework, on-device wherever
  supported. The developer never receives audio or transcripts.

Answering "Data Not Collected" produces the "Data Not Collected" label,
which is accurate here and worth having.

---

## Related answers elsewhere in App Store Connect

**App Tracking Transparency** — not applicable. The app does not track, has
no advertising identifier access, and `NSPrivacyTracking` is `false` in the
privacy manifest. Do **not** add the ATT prompt.

**Export compliance** — SSH adds bundled cryptographic implementation through
Swift Crypto. The previous OS-only HTTPS answer no longer describes the app,
so `project.yml` no longer pre-fills `ITSAppUsesNonExemptEncryption = NO`.
Complete App Store Connect's questionnaire for this binary before distribution
and record any required documentation/code in the release configuration.
See [Apple's encryption documentation workflow](https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation/).

**Content rights** — the app displays only content from the user's own
repository. No third-party content is bundled.

**Advertising identifier (IDFA)** — No.

---

## Keeping it true

The "Data Not Collected" answer stops being true the moment any of these
land, and the label must be updated **before** that build ships:

- any analytics or crash-reporting SDK, including Apple's own if you opt
  into receiving crash data tied to users
- a phren-operated backend or sync relay of any kind
- push notifications routed through a server you control
- any error reporting that transmits store contents or user text

The privacy manifest (`Phren/Resources/PrivacyInfo.xcprivacy`) must stay in
sync with these answers; a mismatch between the manifest and the label is a
common automated rejection.
