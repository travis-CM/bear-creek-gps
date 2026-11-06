import WidgetKit
import SwiftUI
import ActivityKit

private let orange = Color(red: 1.0, green: 0.60, blue: 0.0)

@main
struct LiveBundle: WidgetBundle {
    var body: some Widget { YardsLiveActivity() }
}

struct YardsLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: YardsAttributes.self) { ctx in
            let s = ctx.state
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("HOLE \(s.hole)").font(.system(size: 13, weight: .heavy)).foregroundStyle(.secondary)
                    Text("Par \(s.par)").font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
                }
                Text("\(s.mid)").font(.system(size: 54, weight: .heavy, design: .rounded)).foregroundStyle(orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("plays \(s.plays)").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                    Text("F \(s.front)  ·  B \(s.back)").font(.system(size: 15, weight: .semibold)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .activityBackgroundTint(.black)
        } dynamicIsland: { ctx in
            let s = ctx.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Text("H\(s.hole)").font(.headline).foregroundStyle(orange) }
                DynamicIslandExpandedRegion(.center) { Text("\(s.mid)").font(.system(size: 40, weight: .heavy, design: .rounded)).foregroundStyle(orange) }
                DynamicIslandExpandedRegion(.trailing) { Text("plays \(s.plays)").font(.subheadline.bold()) }
                DynamicIslandExpandedRegion(.bottom) { Text("Front \(s.front)  ·  Back \(s.back)").font(.subheadline) }
            } compactLeading: {
                Text("H\(s.hole)").foregroundStyle(orange)
            } compactTrailing: {
                Text("\(s.mid)").bold().foregroundStyle(orange)
            } minimal: {
                Text("\(s.mid)").foregroundStyle(orange)
            }
        }
    }
}
