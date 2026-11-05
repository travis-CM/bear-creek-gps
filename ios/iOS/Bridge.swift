import Foundation
import CoreLocation
import WatchConnectivity
import WebKit
import UIKit

/// Connects the web app (WKWebView) to native GPS (phone or Apple Watch) and the Watch app.
final class Bridge: NSObject, ObservableObject, CLLocationManagerDelegate, WCSessionDelegate, WKScriptMessageHandler {
    weak var webView: WKWebView?
    private let lm = CLLocationManager()
    private var source: String = UserDefaults.standard.string(forKey: "gpsSource") ?? "phone"
    private var lastState: [String: Any] = [:]
    private var lastWatchFix: Date?
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        lm.delegate = self
        lm.desiredAccuracy = kCLLocationAccuracyBest
        lm.distanceFilter = kCLDistanceFilterNone
        lm.activityType = .fitness
        lm.pausesLocationUpdatesAutomatically = false
        lm.requestWhenInUseAuthorization()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    // MARK: - Location
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.allowsBackgroundLocationUpdates = true
            manager.showsBackgroundLocationIndicator = true
            manager.startUpdatingLocation()
        case .denied, .restricted:
            js("window.bcNative && window.bcNative.err('Location is off for Bear Creek GPS. Turn it on in Settings.')")
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last, l.horizontalAccuracy >= 0 else { return }
        let watchStale = lastWatchFix.map { Date().timeIntervalSince($0) > 20 } ?? true
        if source == "phone" || watchStale {
            sendLocation(l.coordinate.latitude, l.coordinate.longitude, l.horizontalAccuracy, "phone")
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    private func sendLocation(_ lat: Double, _ lon: Double, _ acc: Double, _ src: String) {
        js("window.bcNative && window.bcNative.loc(\(lat),\(lon),\(acc),'\(src)')")
    }

    private func js(_ script: String) {
        DispatchQueue.main.async { self.webView?.evaluateJavaScript(script, completionHandler: nil) }
    }

    // MARK: - Web app -> native
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "source":
            if let v = body["value"] as? String {
                source = v
                UserDefaults.standard.set(v, forKey: "gpsSource")
                pushWatch()
                announce()
            }
        case "state":
            var s = body
            s.removeValue(forKey: "type")
            lastState = s
            pushWatch()
        case "ready":
            announce()
            pushWatch()
        default:
            break
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

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let lat = (message["lat"] as? NSNumber)?.doubleValue,
              let lon = (message["lon"] as? NSNumber)?.doubleValue else { return }
        let acc = (message["acc"] as? NSNumber)?.doubleValue ?? 10
        DispatchQueue.main.async {
            self.lastWatchFix = Date()
            if self.source == "watch" { self.sendLocation(lat, lon, acc, "watch") }
        }
    }
}
