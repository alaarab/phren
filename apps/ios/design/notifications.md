# Phone notifications

Phren's local path uses UNUserNotificationCenter. It needs the user's permission,
not an APNs key or a hosted server. The permission prompt first appears when
the user opens Settings > Notifications, enables a notification kind, or saves
an enabled schedule while the app is active, never at launch. Approvals and
scheduled prompts have independent Phren switches.
Existing direct Hook-to-APNs notifications remain available for an installation
with its own APNs credentials.

## Scheduled prompts

The phone polls each saved computer's authenticated `/v1/schedules` while active
and during background opportunities. It registers one nonrepeating local alert
per enabled, nonrunning schedule with a future next run. The Hook's absolute
`nextRun` is authoritative, including all five timing forms and the assigned
computer's local time. For an edit awaiting store sync, the phone can recompute
using the computer's reported IANA time zone and last actual launch. Older
Hooks without a time zone must confirm the edit before a replacement is added.
The shared PhrenKit computation mirrors Hook interval anchors, cron day matching
and skipped nonexistent wall times at daylight saving transitions.

The title says the schedule is due. The body names the project and the prompt's
first line. This is a reminder, not evidence that the computer is awake or the
prompt ran. A tap reads fresh run history and opens that run's Herdr session.
If it has not launched, is headless, or the computer cannot be reached, the tap
opens schedule history instead. It never opens the previous run as a substitute.

Store refreshes and saved edits reconcile notifications even when the Schedules
screen is closed. Deleted and paused schedules lose their pending and delivered
alerts; changed schedules replace the request with the same stable identity.
Removed computers and failed schedule contacts cancel that computer's reminders.
The next successful contact registers them again. Reconciliation also reads the
notification center after process restart, so it can remove orphaned requests.

The phone cannot learn a remote edit or deletion while suspended or offline.
An already registered reminder can therefore fire from the last known schedule.
It cannot be remotely cancelled without another execution opportunity. There is
no unconditional promise that a remotely deleted schedule never alerts. Local
deletions cancel immediately once the store accepts the change. The phone queues
the earliest 60 reminders to leave room under the system's pending request limit.
Only the next run is registered; later runs require another successful refresh.

## Approvals during the background window

The app keeps a finite UIApplication background lease after leaving the screen,
polling saved computers every three seconds plus request time. A pending badge
is resolved to authenticated pane status. The alert uses the chat card's provider
header, asking sentence, explanation and command, with questions showing their
question text. A tap opens the conversation to review its current card.

Approval identities are hashed and persisted before submission. The ledger
survives answers, expiry, reconnects and process restarts; an approval ID on one
computer never alerts twice through the local path. IDs remain in the ledger for
the lifetime of the app's data. A rejected notification submission is not retried,
favoring at-most-once behavior over possible duplicates. No prompt is stored in
the ledger. The system notification itself necessarily contains its displayed
text. Foreground observations are remembered for delivery when the user leaves.

Answered, expired and removed-session notifications are withdrawn while the app
can execute. An expiry timer runs in the background lease; every later wake also
sweeps expired records. iOS provides no expiration date for delivered local
notifications, so an alert can remain in Notification Center while Phren is
suspended. Reopening it always revalidates the live session before any answer.
iOS can end the lease early or grant no time at all. The 150-second cap is an
upper bound on our work, not a promised duration.

## Background app refresh

One BGAppRefreshTask identifier is registered at launch and listed in project.yml
with the fetch background mode. A request is submitted after foreground use and
again at a refresh wake, with an earliest start 15 minutes later. Each wake polls
saved computers for approvals and schedules. Approval IDs use the same ledger.
An expiration handler and a 20-second deadline cancel work and complete the task
exactly once; late transport results cannot publish notifications.

iOS decides whether and when to wake the app. Background refresh may be delayed
or disabled; force quit, network access and keychain availability also matter.
Short-lived approvals can expire between wakes and never notify. Neither the
background lease nor BGAppRefreshTask offers push-like delivery guarantees.

## Why there is no relay

A shared relay would route other people's work through infrastructure operated
by the project owner. This design keeps polling and local scheduling on the
user's phone and SSH connections on their own computers. A user who provisions
an APNs key can keep using the existing direct APNs path for remote events; that
path is separate from these local preferences and can produce its own alert.

## Verification

PhrenKit tests cover all timing forms, computer time zones, DST, interval anchors,
and persistent approval-ID dedupe. App tests inject a notification center to
check register, replace, unchanged, deletion, pause and capacity behavior, along
with approval withdrawal and background completion. The UI test opens the real
Notifications screen and exercises both Phren switches. Real-device background
grant timing, system delivery and APNs coexistence require device validation.

Apple references: [background refresh](https://developer.apple.com/documentation/backgroundtasks/bgapprefreshtask)
and [delivered notifications](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/getdeliverednotifications(completionhandler:)).
