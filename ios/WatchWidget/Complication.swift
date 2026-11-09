import WidgetKit
import SwiftUI

struct YEntry: TimelineEntry {
    let date: Date
    let hole: Int, mid: Int, front: Int, back: Int
    let live: Bool
}

struct YProvider: TimelineProvider {
    func placeholder(in context: Context) -> YEntry { YEntry(date: Date(), hole: 7, mid: 152, front: 146, back: 160, live: true) }
    func getSnapshot(in context: Context, completion: @escaping (YEntry) -> Void) { completion(entry()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<YEntry>) -> Void) {
        completion(Timeline(entries: [entry()], policy: .after(Date().addingTimeInterval(300))))
    }
    private func entry() -> YEntry {
        let d = WatchShare.defaults
        let ts = d?.double(forKey: "ts") ?? 0
        let fresh = Date().timeIntervalSince1970 - ts < 600
        return YEntry(date: Date(), hole: d?.integer(forKey: "hole") ?? 0, mid: d?.integer(forKey: "mid") ?? 0,
                      front: d?.integer(forKey: "front") ?? 0, back: d?.integer(forKey: "back") ?? 0, live: fresh && (d?.integer(forKey: "mid") ?? 0) > 0)
    }
}

struct YView: View {
    @Environment(\.widgetFamily) var family
    let e: YEntry
    var body: some View {
        switch family {
        case .accessoryCircular:
            VStack(spacing: -2) {
                Text("H\(e.hole)").font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
                Text(e.live ? "\(e.mid)" : "--").font(.system(size: 24, weight: .heavy, design: .rounded)).minimumScaleFactor(0.6)
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 0) {
                Text("HOLE \(e.hole)").font(.system(size: 11, weight: .bold)).foregroundStyle(.secondary)
                Text(e.live ? "\(e.mid) yds" : "-- yds").font(.system(size: 26, weight: .heavy, design: .rounded))
                Text(e.live ? "F \(e.front > 0 ? String(e.front) : "—") · B \(e.back > 0 ? String(e.back) : "—")" : "Start a round").font(.system(size: 12, weight: .semibold))
            }.frame(maxWidth: .infinity, alignment: .leading)
        case .accessoryCorner:
            Text(e.live ? "\(e.mid)" : "--").font(.system(size: 22, weight: .heavy, design: .rounded))
                .widgetLabel("H\(e.hole) · F\(e.front > 0 ? String(e.front) : "—") B\(e.back > 0 ? String(e.back) : "—")")
        default:
            Text(e.live ? "H\(e.hole) \(e.mid) yds" : "GolfHub")
        }
    }
}

@main
struct YardsComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "yards", provider: YProvider()) { e in
            YView(e: e).containerBackground(.black, for: .widget)
        }
        .configurationDisplayName("Yardage")
        .description("Distance to the pin")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryCorner, .accessoryInline])
    }
}
