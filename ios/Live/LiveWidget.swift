import WidgetKit
import SwiftUI
import ActivityKit
import AppIntents

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
                    Text("plays \(s.plays)").font(.system(size: 30, weight: .heavy, design: .rounded)).foregroundStyle(orange)
                }
                Text("\(s.mid)").font(.system(size: 104, weight: .heavy, design: .rounded)).foregroundStyle(.white)
                    .minimumScaleFactor(0.6).lineLimit(1).frame(maxWidth: .infinity)
                HStack {
                    Text("FRONT \(s.front)").font(.system(size: 24, weight: .bold)).foregroundStyle(.white)
                    Spacer()
                    Text("BACK \(s.back)").font(.system(size: 24, weight: .bold)).foregroundStyle(.white)
                }
                HStack(spacing: 10) {
                    Button(intent: AddShotIntent()) {
                        Text(s.shots > 0 ? "+ Shot (\(s.shots))" : "+ Shot").font(.system(size: 20, weight: .heavy)).frame(maxWidth: .infinity).padding(.vertical, 8)
                    }.tint(orange)
                    Button(intent: NextHoleIntent()) {
                        Text("Next hole ▶").font(.system(size: 20, weight: .heavy)).frame(maxWidth: .infinity).padding(.vertical, 8)
                    }.tint(.white)
                }
                .buttonStyle(.borderedProminent).foregroundStyle(.black).padding(.top, 6)
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
