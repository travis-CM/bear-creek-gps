import Foundation
#if os(iOS)
import ActivityKit

struct YardsAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var hole: Int
        var par: Int
        var mid: Int
        var plays: Int
        var front: Int
        var back: Int
    }
    var name: String
}
#endif

/// Written by the Watch app, read by the Watch complication (App Group).
enum WatchShare {
    static let group = "group.com.travisgafford.bearcreekgps"
    static var defaults: UserDefaults? { UserDefaults(suiteName: group) }
}
