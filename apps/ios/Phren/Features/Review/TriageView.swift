import SwiftUI
import PhrenKit

/// One card in a triage session.
///
/// Deliberately a *copy* of the queue entry rather than a live view of it:
/// once a session starts the deck must not reshuffle under the user's thumb
/// because a poll landed or a buffered op flushed. Text and line are var
/// because an edit rewrites both in place.
struct TriageCard: Identifiable {
    let id: String
    let storeId: String
    let storeName: String
    let project: String
    let section: QueueItem.Section
    let date: String
    let confidence: Double?
    let risky: Bool
    let machine: String?
    let modelName: String?
    var text: String
    var line: String

    init(_ entry: StoreQueueEntry) {
        id = entry.id
        storeId = entry.storeId
        storeName = entry.storeName
        project = entry.entry.project
        section = entry.entry.item.section
        date = entry.entry.item.date
        confidence = entry.entry.item.confidence
        risky = entry.entry.item.risky
        machine = entry.entry.item.machine
        modelName = entry.entry.item.model
        text = entry.entry.item.text
        line = entry.entry.item.line
    }

    /// The text as `ReviewFile.edit` will write it (newlines collapsed to
    /// spaces, trimmed) — ReviewFile.swift:148.
    static func normalized(_ text: String) -> String {
        text.replacingOccurrences(of: "[\r\n]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The line an `editQueue` op leaves behind, mirroring
    /// `ReviewFile.edit` (access.ts:728): the `- [date] ` prefix survives,
    /// everything after it is replaced. Keeping this in sync locally means the
    /// next approve/reject on this card still matches by line.
    static func rewrittenLine(_ line: String, newText: String) -> String {
        if let range = line.range(of: #"^- \[\d{4}-\d{2}-\d{2}\]"#, options: .regularExpression) {
            let date = line[range].dropFirst(3).dropLast(1)
            return "- [\(date)] \(newText)"
        }
        return "- \(newText)"
    }
}

/// Full-screen one-at-a-time review: the queue as a deck of cards you swipe
/// right to approve and left to reject.
///
/// Two ideas carry the design:
///
/// 1. **Nothing is enqueued while you can still take it back.** A decision
///    parks in a grace buffer and is only handed to the sync engine when the
///    undo window expires, the next decision pushes it out, or the session
///    ends. Undo therefore needs no op-cancellation API — the op never
///    existed. Offline-first is untouched: the flush is a normal
///    `model.perform`, and the engine coalesces the resulting run of
///    same-file ops into a single commit.
/// 2. **The deck is a snapshot.** See `TriageCard`.
struct TriageView: View {
    let entries: [StoreQueueEntry]

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var deck: [TriageCard]
    @State private var total: Int
    /// Terminal state per card id — every card that leaves the deck has one,
    /// so the summary always adds up to the deck size.
    @State private var outcomes: [String: Outcome] = [:]
    /// Cards that have already been sent to the back once. A second skip
    /// drops them for good, so an all-skipped deck can't loop forever.
    @State private var skippedOnce: Set<String> = []
    @State private var buffered: BufferedDecision?
    @State private var editing: TriageCard?
    @State private var drag: CGSize = .zero
    @State private var pastThreshold = false
    @State private var approveTick = 0
    @State private var rejectTick = 0
    /// Counts threshold crossings *during a drag* only, so the internal reset
    /// after a commit doesn't fire a second haptic on top of the success one.
    @State private var thresholdTick = 0
    @State private var rejectConfirmed = false
    @State private var confirmingReject = false
    /// True while a card is flying off — actions are locked so a second tap
    /// can't land on the card underneath.
    @State private var committing = false
    /// Set the instant Done is tapped, so a decision still in flight enqueues
    /// straight away instead of parking in a buffer nobody will flush.
    @State private var closing = false

    /// Past this much horizontal travel, release commits.
    private let threshold: CGFloat = 110
    /// How long a decision sits in the grace buffer before it's enqueued.
    private let undoWindow: Duration = .seconds(4)

    init(entries: [StoreQueueEntry]) {
        self.entries = entries
        _deck = State(initialValue: entries.map(TriageCard.init))
        _total = State(initialValue: entries.count)
    }

    enum Outcome { case approved, rejected, skipped }

    /// A decision made but not yet handed to the sync engine.
    struct BufferedDecision: Identifiable {
        let id = UUID()
        let card: TriageCard
        let approved: Bool
    }

    var body: some View {
        ZStack {
            PhrenTheme.bg.ignoresSafeArea()
            swipeTint.ignoresSafeArea()

            VStack(spacing: 0) {
                header
                ActionErrorBanner()
                Group {
                    if let card = deck.first {
                        cardStack(top: card)
                    } else {
                        TriageSummary(
                            approved: count(of: .approved),
                            rejected: count(of: .rejected),
                            skipped: count(of: .skipped),
                            onDone: finish
                        )
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                undoToast
                if !deck.isEmpty {
                    controls
                }
            }
        }
        .preferredColorScheme(.dark)
        .sensoryFeedback(.success, trigger: approveTick)
        .sensoryFeedback(.warning, trigger: rejectTick)
        .sensoryFeedback(.selection, trigger: thresholdTick)
        .task(id: buffered?.id) { await runUndoWindow() }
        .onDisappear { flushBuffer() }
        .sheet(item: $editing) { card in
            TextEntrySheet(
                title: "Edit before approving",
                initialText: card.text,
                confirmLabel: "Save"
            ) { text, _ in
                await applyEdit(to: card, newText: text)
            }
        }
        .phrenDialog(
            isPresented: $confirmingReject,
            title: "Reject deletes this finding",
            message: "Rejecting removes the finding from FINDINGS.md permanently. "
                + "You still get a few seconds to undo. Asked once per session.",
            actions: [
                .init(id: "reject", title: "Reject", role: .destructive) {
                    rejectConfirmed = true
                    commitSwipe(-1)
                },
                .init(id: "keep", title: "Keep it", role: .cancel) {},
            ],
            identifier: "triage-reject-dialog"
        )
    }

    // MARK: - Header

    private var resolvedCount: Int { total - deck.count }

    private var header: some View {
        VStack(spacing: 10) {
            HStack {
                Button(action: finish) {
                    Label("Done", systemImage: "chevron.down")
                        .font(.subheadline.weight(.medium))
                        .labelStyle(.titleAndIcon)
                }
                .foregroundStyle(PhrenTheme.textSecondary)
                Spacer()
                Text("\(deck.isEmpty ? total : resolvedCount + 1) of \(total)")
                    .font(.caption.monospaced())
                    .foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityLabel("Item \(deck.isEmpty ? total : resolvedCount + 1) of \(total)")
            }
            progressBar
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
        .padding(.bottom, 14)
    }

    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(PhrenTheme.border)
                Capsule()
                    .fill(PhrenTheme.accent)
                    .frame(width: geo.size.width * progressFraction)
                    .shadow(color: PhrenTheme.accent.opacity(0.6), radius: 4)
            }
        }
        .frame(height: 3)
        .animation(.easeOut(duration: 0.25), value: progressFraction)
        .accessibilityHidden(true)
    }

    private var progressFraction: CGFloat {
        guard total > 0 else { return 1 }
        return CGFloat(resolvedCount) / CGFloat(total)
    }

    // MARK: - Deck

    /// How far the swipe has gone toward committing (horizontal only) — drives
    /// the background tint.
    private var swipeProgress: CGFloat {
        min(abs(drag.width) / threshold, 1)
    }

    /// How much of the next card to reveal. Any direction counts, so the skip
    /// (which throws the card downward) uncovers the deck too.
    private var revealProgress: CGFloat {
        min(max(abs(drag.width), abs(drag.height) * 1.4) / threshold, 1)
    }

    private var swipeTint: some View {
        (drag.width >= 0 ? PhrenTheme.green : PhrenTheme.red)
            .opacity(deck.isEmpty ? 0 : Double(swipeProgress) * 0.14)
    }

    private func cardStack(top: TriageCard) -> some View {
        ZStack {
            // The next card sits under the top one and rises as it leaves, so
            // a swipe reveals rather than replaces. At full reveal it is
            // pixel-identical to a top card, which is what lets the swap at
            // the end of the fly-out be instantaneous and invisible.
            if let next = deck.dropFirst().first {
                TriageCardFace(card: next, showStore: model.hasMultipleStores, secondPass: skippedOnce.contains(next.id))
                    .scaleEffect(0.94 + 0.06 * revealProgress)
                    .opacity(0.45 + 0.55 * Double(revealProgress))
                    .offset(y: 14 - 14 * revealProgress)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }

            TriageCardFace(card: top, showStore: model.hasMultipleStores, secondPass: skippedOnce.contains(top.id))
                // Identity on the face alone: the card's scroll position
                // resets per item, while the offset/rotation live on a stable
                // container that the fly-out animation can own. The transition
                // only ever renders for undo — the approve/skip swaps are
                // deliberately outside any animation.
                .transition(.scale(scale: 0.92).combined(with: .opacity))
                .id(top.id)
                .overlay(alignment: .topLeading) {
                    TriageStamp(text: "APPROVE", color: PhrenTheme.green, angle: -14)
                        .opacity(stampOpacity(forward: true))
                        .padding(22)
                }
                .overlay(alignment: .topTrailing) {
                    TriageStamp(text: "REJECT", color: PhrenTheme.red, angle: 14)
                        .opacity(stampOpacity(forward: false))
                        .padding(22)
                }
                .offset(drag)
                .rotationEffect(.degrees(rotation), anchor: .bottom)
                .gesture(swipe)
                .allowsHitTesting(!committing)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(accessibilityLabel(for: top))
                .accessibilityHint("Swipe right to approve, left to reject.")
                .accessibilityAction(named: "Approve") { commitSwipe(1) }
                .accessibilityAction(named: "Reject") { commitSwipe(-1) }
                .accessibilityAction(named: "Skip") { skip() }
                .accessibilityAction(named: "Edit") { startEdit() }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }

    private var rotation: Double {
        min(max(Double(drag.width) / 22, -13), 13)
    }

    /// The stamp is dead until the swipe means something, then ramps to full
    /// exactly at the commit threshold — so "solid label" reads as "let go".
    private func stampOpacity(forward: Bool) -> Double {
        guard forward ? drag.width > 0 : drag.width < 0 else { return 0 }
        let travel = abs(drag.width)
        let start = threshold * 0.35
        guard travel > start else { return 0 }
        return Double(min((travel - start) / (threshold - start), 1))
    }

    private var swipe: some Gesture {
        DragGesture()
            .onChanged { value in
                // Vertical travel is damped: this is a left/right decision and
                // the card should say so.
                drag = CGSize(width: value.translation.width, height: value.translation.height * 0.22)
                let crossed = abs(value.translation.width) > threshold
                if crossed != pastThreshold {
                    pastThreshold = crossed
                    thresholdTick += 1
                }
            }
            .onEnded { value in
                // A quick flick counts even if it stopped short.
                let projected = value.translation.width + value.predictedEndTranslation.width * 0.25
                if projected > threshold {
                    commitSwipe(1)
                } else if projected < -threshold {
                    commitSwipe(-1)
                } else {
                    springBack()
                }
            }
    }

    private func accessibilityLabel(for card: TriageCard) -> String {
        var parts = ["\(card.section.rawValue) item in \(card.project)"]
        if model.hasMultipleStores { parts.append("store \(card.storeName)") }
        parts.append(card.date)
        parts.append(card.text)
        return parts.joined(separator: ". ")
    }

    // MARK: - Controls

    private var controls: some View {
        VStack(spacing: 12) {
            HStack(spacing: 26) {
                TriageActionButton(systemImage: "xmark", tint: PhrenTheme.red, label: "Reject", diameter: 62) {
                    commitSwipe(-1)
                }
                TriageActionButton(systemImage: "pencil", tint: PhrenTheme.lavender, label: "Edit", diameter: 50) {
                    startEdit()
                }
                TriageActionButton(systemImage: "checkmark", tint: PhrenTheme.green, label: "Approve", diameter: 62) {
                    commitSwipe(1)
                }
            }
            Button(action: skip) {
                Label("Skip for now", systemImage: "arrow.uturn.down")
                    .font(.footnote)
            }
            .foregroundStyle(PhrenTheme.textMuted)
            .accessibilityHint("Moves this item to the end of the deck without deciding.")
        }
        .padding(.bottom, 14)
    }

    private var undoToast: some View {
        ZStack {
            if let buffered {
                HStack(spacing: 10) {
                    Image(systemName: buffered.approved ? "checkmark.circle.fill" : "trash.circle.fill")
                        .foregroundStyle(buffered.approved ? PhrenTheme.green : PhrenTheme.red)
                    Text(buffered.approved ? "Approved" : "Rejected")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(PhrenTheme.text)
                    Rectangle()
                        .fill(PhrenTheme.border)
                        .frame(width: 1, height: 14)
                    Button("Undo") { undo() }
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(PhrenTheme.cyan)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 9)
                .background(PhrenTheme.surfaceRaised, in: Capsule())
                .overlay(Capsule().stroke(PhrenTheme.border, lineWidth: 1))
                .shadow(color: .black.opacity(0.4), radius: 8, y: 3)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(height: 48)
        .animation(.spring(response: 0.3, dampingFraction: 0.85), value: buffered?.id)
    }

    // MARK: - Decisions

    private func count(of outcome: Outcome) -> Int {
        outcomes.values.filter { $0 == outcome }.count
    }

    /// Fly the top card out, then record the decision. Reject detours through
    /// a one-per-session confirmation first.
    private func commitSwipe(_ direction: CGFloat) {
        guard !deck.isEmpty, !committing else { return }
        if direction < 0, !rejectConfirmed {
            springBack()
            confirmingReject = true
            return
        }
        committing = true
        withAnimation(.easeOut(duration: 0.22)) {
            drag = CGSize(width: direction * 700, height: drag.height)
        } completion: {
            decide(approved: direction > 0)
        }
    }

    /// Runs once the card is off-screen. The deck swap is deliberately
    /// *un*animated: the next card has already risen to full size behind the
    /// one that left, so replacing it in a single frame is invisible — and it
    /// gives the incoming card a clean scroll position.
    private func decide(approved: Bool) {
        committing = false
        guard let card = deck.first else { return }
        // The previous decision loses its undo the moment a new one lands.
        flushBuffer()
        outcomes[card.id] = approved ? .approved : .rejected
        if approved { approveTick += 1 } else { rejectTick += 1 }
        deck.removeFirst()
        drag = .zero
        pastThreshold = false
        if closing {
            // No screen left to host an undo window — enqueue it now.
            enqueue(BufferedDecision(card: card, approved: approved))
        } else {
            buffered = BufferedDecision(card: card, approved: approved)
        }
    }

    private func undo() {
        guard let decision = buffered else { return }
        buffered = nil
        outcomes[decision.card.id] = nil
        drag = .zero
        pastThreshold = false
        withAnimation(.spring(response: 0.34, dampingFraction: 0.8)) {
            deck.insert(decision.card, at: 0)
        }
    }

    /// Toss the card down and out — a different direction from approve/reject
    /// so the motion itself says "not a decision".
    private func skip() {
        guard !deck.isEmpty, !committing else { return }
        committing = true
        withAnimation(.easeOut(duration: 0.22)) {
            drag = CGSize(width: drag.width, height: 900)
        } completion: {
            advanceSkip()
        }
    }

    private func advanceSkip() {
        committing = false
        guard let card = deck.first else { return }
        deck.removeFirst()
        if !skippedOnce.contains(card.id) {
            // Once round the back; a second skip drops it so a deck of
            // nothing-but-skips can't loop forever.
            skippedOnce.insert(card.id)
            deck.append(card)
        }
        if outcomes[card.id] == nil { outcomes[card.id] = .skipped }
        drag = .zero
        pastThreshold = false
    }

    private func startEdit() {
        guard !committing else { return }
        editing = deck.first
    }

    private func springBack() {
        pastThreshold = false
        withAnimation(.spring(response: 0.34, dampingFraction: 0.7)) {
            drag = .zero
        }
    }

    private func finish() {
        closing = true
        flushBuffer()
        dismiss()
    }

    // MARK: - Grace buffer

    /// Holds the decision for the length of the undo window, then enqueues it.
    private func runUndoWindow() async {
        guard let decision = buffered else { return }
        try? await Task.sleep(for: undoWindow)
        guard !Task.isCancelled, buffered?.id == decision.id else { return }
        buffered = nil
        enqueue(decision)
    }

    /// Hand any buffered decision to the sync engine now. Called when the next
    /// decision arrives, when triage closes, and when the window expires.
    private func flushBuffer() {
        guard let decision = buffered else { return }
        buffered = nil
        enqueue(decision)
    }

    private func enqueue(_ decision: BufferedDecision) {
        let card = decision.card
        let op: PendingOp = decision.approved
            ? .approveQueue(project: card.project, line: card.line)
            : .rejectQueue(project: card.project, line: card.line)
        // Deliberately detached from this view's lifetime: the flush must
        // land even when it's triggered by the screen going away.
        Task { await model.perform(op, in: card.storeId) }
    }

    /// Edits skip the grace buffer — the sheet's Save is the confirmation —
    /// so any buffered decision is flushed first to keep op order honest.
    private func applyEdit(to card: TriageCard, newText: String) async {
        flushBuffer()
        await model.perform(
            .editQueue(project: card.project, line: card.line, newText: newText),
            in: card.storeId
        )
        guard let index = deck.firstIndex(where: { $0.id == card.id }) else { return }
        let normalized = TriageCard.normalized(newText)
        deck[index].text = normalized
        deck[index].line = TriageCard.rewrittenLine(card.line, newText: normalized)
    }
}

// MARK: - Card face

private struct TriageCardFace: View {
    let card: TriageCard
    let showStore: Bool
    let secondPass: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                TagChip(text: card.project, role: .project)
                if showStore {
                    TagChip(text: card.storeName, role: .store)
                }
                Spacer()
                TagChip(text: card.section.rawValue.lowercased(), color: sectionColor)
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)

            // minHeight = the whole card body, so a one-liner sits centered
            // and a long finding scrolls from the top like a document.
            GeometryReader { geo in
                ScrollView {
                    Text(card.text)
                        .font(.system(size: 21, weight: .regular))
                        .lineSpacing(5)
                        .foregroundStyle(PhrenTheme.text)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 22)
                        .frame(maxWidth: .infinity, minHeight: geo.size.height, alignment: .leading)
                }
                .scrollBounceBehavior(.basedOnSize)
            }

            Divider().overlay(PhrenTheme.border)

            HStack(spacing: 8) {
                Text(card.date)
                    .font(.caption2.monospaced())
                    .foregroundStyle(PhrenTheme.textMuted)
                if let confidence = card.confidence {
                    Text(String(format: "conf %.0f%%", confidence * 100))
                        .font(.caption2.monospaced())
                        .foregroundStyle(confidence < 0.7 ? PhrenTheme.amber : PhrenTheme.textMuted)
                }
                if let machine = card.machine {
                    Text(machine).font(.caption2.monospaced()).foregroundStyle(PhrenTheme.textDim)
                }
                if let modelName = card.modelName {
                    Text(modelName).font(.caption2.monospaced()).foregroundStyle(PhrenTheme.textDim)
                }
                Spacer()
                if secondPass {
                    Text("skipped once")
                        .font(.caption2.monospaced())
                        .foregroundStyle(PhrenTheme.lavender)
                }
                if card.risky {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(PhrenTheme.amber)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .phrenCard()
    }

    private var sectionColor: Color {
        switch card.section {
        case .review: return PhrenTheme.accentHover
        case .stale: return PhrenTheme.amber
        case .conflicts: return PhrenTheme.red
        }
    }
}

// MARK: - Pieces

/// The swipe verdict, stamped on the card like a rubber stamp — the same
/// squared-off bordered treatment as TagChip, blown up.
private struct TriageStamp: View {
    let text: String
    let color: Color
    let angle: Double

    var body: some View {
        Text(text)
            .font(.system(size: 24, weight: .heavy, design: .monospaced))
            .tracking(2)
            .foregroundStyle(color)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(color, lineWidth: 3))
            .rotationEffect(.degrees(angle))
            .shadow(color: color.opacity(0.35), radius: 10)
            .accessibilityHidden(true)
    }
}

private struct TriageActionButton: View {
    let systemImage: String
    let tint: Color
    let label: String
    let diameter: CGFloat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: diameter * 0.38, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: diameter, height: diameter)
                .background(tint.opacity(0.12), in: Circle())
                .overlay(Circle().stroke(tint.opacity(0.5), lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// Where a session lands: what you did, and a way out.
private struct TriageSummary: View {
    let approved: Int
    let rejected: Int
    let skipped: Int
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            PhrenMascotView(size: 96, bobbing: true, glow: true)
            VStack(spacing: 6) {
                Text(headline)
                    .font(.title3.monospaced().weight(.semibold))
                    .foregroundStyle(PhrenTheme.text)
                Text(subhead)
                    .font(.footnote)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            }
            HStack(spacing: 10) {
                stat(approved, "approved", PhrenTheme.green)
                stat(rejected, "rejected", PhrenTheme.red)
                stat(skipped, "skipped", PhrenTheme.lavender)
            }
            Spacer()
            Button(action: onDone) {
                Text("Done")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(PhrenTheme.accentSolid, in: RoundedRectangle(cornerRadius: 8))
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 32)
        }
        .padding(.bottom, 8)
    }

    private var headline: String {
        approved + rejected == 0 ? "Nothing decided" : "Queue triaged"
    }

    private var subhead: String {
        if skipped > 0 {
            return "Skipped items stay in the queue — they'll be waiting next time."
        }
        return approved + rejected == 0
            ? "The deck is back where it started."
            : "Changes sync as soon as the network allows."
    }

    private func stat(_ value: Int, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 4) {
            Text("\(value)")
                .font(.system(size: 30, weight: .bold, design: .monospaced))
                .foregroundStyle(color)
            Text(label)
                .font(.caption2.monospaced())
                .foregroundStyle(PhrenTheme.textMuted)
        }
        .frame(width: 92)
        .padding(.vertical, 12)
        .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(PhrenTheme.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(value) \(label)")
    }
}
