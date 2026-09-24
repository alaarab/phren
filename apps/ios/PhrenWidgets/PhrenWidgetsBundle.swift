import WidgetKit
import SwiftUI

@main
struct PhrenWidgetsBundle: WidgetBundle {
    var body: some Widget {
        PhrenGlanceWidget()
        ApprovalActivityWidget()
        SessionWorkingActivityWidget()
        if #available(iOS 18.0, *) {
            SessionAttentionControl()
            WorkingActivityControl()
            TalkToConductorControl()
            PauseAllAgentsControl()
        }
    }
}
