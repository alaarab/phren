import WidgetKit
import SwiftUI

/// One widget configuration spanning all four supported families — Home
/// Screen small/medium plus the two Lock Screen accessory kinds. They all
/// read the same snapshot, so one `TimelineProvider` and one `kind` cover
/// every size; `PhrenWidgetView` just switches on `widgetFamily`.
struct PhrenGlanceWidget: Widget {
    let kind = "com.phren.ios.widgets.glance"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: PhrenTimelineProvider()) { entry in
            PhrenWidgetView(entry: entry)
        }
        .configurationDisplayName("phren")
        .description("Your project memory and top active task, at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}
