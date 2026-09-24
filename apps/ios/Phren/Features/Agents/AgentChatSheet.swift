import PhrenKit
import PhrenLive
import SwiftUI

/// Every agent opens in Phren with its exact computer and conversation.
struct AgentConversationLink<LabelContent: View>: View {
    let session: LiveAgentSession
    var onOpenInPhren: (() -> Void)? = nil
    @ViewBuilder var label: LabelContent

    var body: some View {
        Group {
            if let onOpenInPhren {
                Button {
                    ChatJourney.begin()
                    PhrenAppShortcuts.donateOpen(session)
                    onOpenInPhren()
                } label: { label }
            } else {
                NavigationLink {
                    AgentSessionDestination(session: session).onAppear { PhrenAppShortcuts.donateOpen(session) }
                } label: { label }
                .simultaneousGesture(TapGesture().onEnded { ChatJourney.begin() })
            }
        }
    }
}

struct AgentSessionDestination: View {
    let session: LiveAgentSession
    var body: some View {
        if ChatSettings.opensInTerminal { HerdrTerminalView(host: session.host, session: session) }
        else { AgentChatSheet(session: session) }
    }
}

struct AgentChildRequest: Equatable {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let agent: AgentChild
}

struct AgentChatSheet: View {
    @State private var session: LiveAgentSession
    @State private var incomingAttachments: [AgentAttachment]
    @State private var incomingDraft: String
    @State private var requestedChild: AgentChildRequest?
    private let initialSessionID: LiveAgentSession.ID
    private let initialPane: AgentChatPanes.Pane?
    private let initialTarget: AgentChatTarget?
    private let startsDictation: Bool
    init(session: LiveAgentSession, initialPane: AgentChatPanes.Pane? = nil,
         initialTarget: AgentChatTarget? = nil,
         attachments: [AgentAttachment] = [], draft: String = "", startsDictation: Bool = false,
         initialChild: AgentChildRequest? = nil) {
        _session = State(initialValue: session)
        _incomingAttachments = State(initialValue: attachments)
        _incomingDraft = State(initialValue: draft)
        _requestedChild = State(initialValue: initialChild)
        initialSessionID = session.id
        self.initialPane = initialPane
        self.initialTarget = initialTarget
        self.startsDictation = startsDictation
    }
    var body: some View {
        AgentChatView(session: session, switchSession: { session = $0 },
                      initialPane: session.id == initialSessionID ? initialPane : nil,
                      initialTarget: session.id == initialSessionID ? initialTarget : nil,
                      incomingAttachments: $incomingAttachments, incomingDraft: $incomingDraft,
                      requestedChild: $requestedChild,
                      startsDictation: startsDictation && session.id == initialSessionID,
                      model: AgentChatModels.model(for: session.id, pane: session.id == initialSessionID
                                                   ? initialTarget?.id ?? initialPane?.id : nil)).id(session.id)
    }
}
