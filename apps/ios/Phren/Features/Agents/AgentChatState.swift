import Observation
import PhrenKit

/// What the transcript draws: the prepared timeline rows and what rides with
/// them. Owned by `AgentChatModel`, which publishes a preparation here in one
/// step. The transcript pane observes this object; the chat's header,
/// composer and cards never read it, so a new row redraws the transcript alone.
@Observable @MainActor
final class AgentChatTimelineState {
    var entries: [ChatTimelineEntry] = []
    /// Moves with every published preparation.
    var revision = 0
    /// The reply being written, until its transcript row lands.
    var replyPreview: AgentChatPreview?
    var backgroundJobs: [ChatBackgroundJob] = []
    var currentToolName: String?
    var currentToolDetail: String?
    /// Local previews of pictures sent from this phone, by user message.
    var imagesByMessage: [String: [ChatAttachmentDraft]] = [:]
    /// The history's paging state, mirrored here so the pane observes these
    /// values and not every change to the history. Set only when they change.
    var historyStartLine: Int?
    var hasMore = false
    var hasNewer = false
    var hasMessages = false
}

/// The message being written and its delivery. Owned by `AgentChatModel`;
/// the composer observes it, and typing redraws nothing else.
@Observable @MainActor
final class AgentChatComposerState {
    var draft = ""
    var attachments: [ChatAttachmentDraft] = []
    var sending = false
    var deliveryStatus: String?
    var deliveryError: String?
    var draftStorageError: String?
}
