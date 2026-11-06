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
            VStack(spacing: 2) {
                HStack {
                    Text("HOLE \(s.hole)  ·  PAR \(s.par)").font(.system(size: 20, weight: .heavy)).foregroundStyle(.secondary)
                    Spacer()
                    Text("plays \(s.plays)").font(.system(size: 30, weight: .heavy, design: .rounded)).foregroundStyle(.white)
                }
                Text("\(s.mid)").font(.system(size: 104, weight: .heavy, design: .rounded)).foregroundStyle(orange)
                    .minimumScaleFactor(0.6).lineLimit(1).frame(maxWidth: .infinity)
                HStack {
                    Text("FRONT \(s.front)").font(.system(size: 24, weight: .bold)).foregroundStyle(.white)
                    Spacer()
                    Text("BACK \(s.back)").font(.system(size: 24, weight: .bold)).foregroundStyle(.white)
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
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
