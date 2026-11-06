import Foundation
#if os(iOS)
import ActivityKit
import AppIntents

struct YardsAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var hole: Int
        var par: Int
        var mid: Int
        var plays: Int
        var front: Int
        var back: Int
        var shots: Int = 0
    }
    var name: String
}

/// Buttons on the lock-screen Live Activity. perform() runs inside the app process.
enum LiveCommands { static var handler: ((String) -> Void)? }

struct AddShotIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Add shot"
    func perform() async throws -> some IntentResult { LiveCommands.handler?("shot"); return .result() }
}
struct NextHoleIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Next hole"
    func perform() async throws -> some IntentResult { LiveCommands.handler?("next"); return .result() }
}
#endif

/// Written by the Watch app, read by the Watch complication (App Group).
enum WatchShare {
    static let group = "group.com.travisgafford.bearcreekgps"
    static var defaults: UserDefaults? { UserDefaults(suiteName: group) }
}
