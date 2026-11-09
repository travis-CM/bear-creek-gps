import SwiftUI
import UIKit

@main
struct BearCreekGPSApp: App {
    @StateObject private var bridge = Bridge()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            WebContainer(bridge: bridge)
                .ignoresSafeArea()
                .background(Color(red: 0.06, green: 0.08, blue: 0.07))
                .preferredColorScheme(.dark)
                .onAppear {
                    bridge.start()
                }
        }
        .onChange(of: phase) { _, newPhase in
            if newPhase == .active { bridge.announce() }
        }
    }
}
