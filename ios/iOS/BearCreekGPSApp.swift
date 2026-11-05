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
                    UIApplication.shared.isIdleTimerDisabled = true
                    bridge.start()
                }
        }
        .onChange(of: phase) { _, newPhase in
            // keep the screen awake on the course while the app is open
            UIApplication.shared.isIdleTimerDisabled = (newPhase == .active)
            if newPhase == .active { bridge.announce() }
        }
    }
}
