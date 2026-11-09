import Foundation
import CoreLocation
import WatchConnectivity
import WebKit
import UIKit
import ActivityKit

/// Connects the web app (WKWebView) to native GPS (phone or Apple Watch) and the Watch app.
final class Bridge: NSObject, ObservableObject, CLLocationManagerDelegate, WCSessionDelegate, WKScriptMessageHandler {
    weak var webView: WKWebView?
    private let lm = CLLocationManager()
    private var source: String = UserDefaults.standard.string(forKey: "gpsSource") ?? "phone"
    private var lastState: [String: Any] = [:]
    private var lastWatchFix: Date?
    private var started = false
    private var webReady = false
    private var pendingCmds: [(String, Int)] = []

    override init() {
        super.init()
        // set up early: a lock-screen button or the Watch can launch the app in the background before any view appears
        LiveCommands.handler = { [weak self] c in DispatchQueue.main.async { self?.command(c) } }
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    func start() {
        guard !started else { return }
        started = true
        lm.delegate = self
        applyGPSMode()
        lm.activityType = .fitness
        lm.pausesLocationUpdatesAutomatically = false
        lm.requestWhenInUseAuthorization()
    }

    // MARK: - Location
    /// Phone GPS at full power only when it is the chosen source; with the Watch as source the phone just idles as a fallback.
    private func applyGPSMode() {
        if source == "phone" {
            lm.desiredAccuracy = kCLLocationAccuracyBest
            lm.distanceFilter = 3
        } else {
            lm.desiredAccuracy = kCLLocationAccuracyHundredMeters
            lm.distanceFilter = 50
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.allowsBackgroundLocationUpdates = true
            manager.showsBackgroundLocationIndicator = true
            manager.startUpdatingLocation()
        case .denied, .restricted:
            js("window.bcNative && window.bcNative.err('Location is off for GolfHub. Turn it on in Settings.')")
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last, l.horizontalAccuracy >= 0, l.horizontalAccuracy <= 100,
              abs(l.timestamp.timeIntervalSinceNow) < 15 else { return }
        let watchStale = lastWatchFix.map { Date().timeIntervalSince($0) > 20 } ?? true
        if source == "phone" || watchStale {
            sendLocation(l.coordinate.latitude, l.coordinate.longitude, l.horizontalAccuracy, "phone")
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    private func sendLocation(_ lat: Double, _ lon: Double, _ acc: Double, _ src: String) {
        guard lat.isFinite, lon.isFinite, acc.isFinite, acc >= 0 else { return }
        js("window.bcNative && window.bcNative.loc(\(lat),\(lon),\(acc),'\(src)')")
    }

    func command(_ name: String, hole: Int = 0) {
        guard ["shot", "next", "undo"].contains(name), (0...18).contains(hole) else { return }
        if webReady && webView != nil { js("window.bcNative && window.bcNative.cmd('\(name)',\(hole))") }
        else { pendingCmds.append((name, hole)) }   // replayed when the web app reports ready
    }

    private func js(_ script: String) {
        DispatchQueue.main.async { self.webView?.evaluateJavaScript(script, completionHandler: nil) }
    }

    // MARK: - Web app -> native
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "source":
            if let v = body["value"] as? String, v == "phone" || v == "watch" {
                source = v
                UserDefaults.standard.set(v, forKey: "gpsSource")
                applyGPSMode()
                pushWatch()
                announce()
            }
        case "state":
            var s = body
            s.removeValue(forKey: "type")
            lastState = s
            pushWatch()
        case "live":
            updateActivity(body)
        case "endlive":
            endActivity()
        case "ready":
            webReady = true
            announce()
            pushWatch()
            let q = pendingCmds; pendingCmds = []
            q.forEach { command($0.0, hole: $0.1) }
        default:
            break
        }
    }

    // MARK: - Lock screen Live Activity
    private var activity: Activity<YardsAttributes>?
    private func updateActivity(_ b: [String: Any]) {
        func n(_ k: String) -> Int { (b[k] as? NSNumber)?.intValue ?? 0 }
        let st = YardsAttributes.ContentState(hole: n("hole"), par: n("par"), mid: n("mid"), plays: n("plays"), front: n("front"), back: n("back"), shots: n("shots"))
        DispatchQueue.main.async {
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
            let content = ActivityContent(state: st, staleDate: Date().addingTimeInterval(120))
            let alive = { (a: Activity<YardsAttributes>) in a.activityState == .active || a.activityState == .stale }
            if let a = [self.activity].compactMap({ $0 }).first(where: alive) ?? Activity<YardsAttributes>.activities.first(where: alive) {
                self.activity = a
                Task { await a.update(content) }
            } else if UIApplication.shared.applicationState == .active {
                self.activity = try? Activity.request(attributes: YardsAttributes(name: "GolfHub"), content: content)
            }
        }
    }

    private func endActivity() {
        DispatchQueue.main.async {
            let list = Activity<YardsAttributes>.activities
            self.activity = nil
            Task { for a in list { await a.end(nil, dismissalPolicy: .immediate) } }
        }
    }

    func announce() {
        var paired = false
        if WCSession.isSupported() {
            let s = WCSession.default
            paired = s.activationState == .activated && s.isPaired && s.isWatchAppInstalled
        }
        js("window.bcNative && window.bcNative.setSource('\(source)', \(paired))")
    }

    private func pushWatch() {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        var ctx = lastState
        ctx["streamGPS"] = (source == "watch")
        ctx["ts"] = Date().timeIntervalSince1970
        try? WCSession.default.updateApplicationContext(ctx)
    }

    // MARK: - Watch connectivity
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async { self.pushWatch(); self.announce() }
    }
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    func sessionWatchStateDidChange(_ session: WCSession) { DispatchQueue.main.async { self.announce() } }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        if let c = userInfo["cmd"] as? String {
            let h = (userInfo["hole"] as? NSNumber)?.intValue ?? 0
            DispatchQueue.main.async { self.command(c, hole: h) }
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        if let c = message["cmd"] as? String {
            let h = (message["hole"] as? NSNumber)?.intValue ?? 0
            DispatchQueue.main.async { self.command(c, hole: h) }; return
        }
        guard let lat = (message["lat"] as? NSNumber)?.doubleValue,
              let lon = (message["lon"] as? NSNumber)?.doubleValue else { return }
        let acc = (message["acc"] as? NSNumber)?.doubleValue ?? 10
        DispatchQueue.main.async {
            self.lastWatchFix = Date()
            if self.source == "watch" { self.sendLocation(lat, lon, acc, "watch") }
        }
    }
}
