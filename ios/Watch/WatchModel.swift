import Foundation
import CoreLocation
import WatchConnectivity
import HealthKit

/// Live distance + plays-like on the watch, from the watch's own GPS.
/// Hole, pin and weather come from the iPhone app; the watch falls back to its bundled course data.
final class WatchModel: NSObject, ObservableObject, CLLocationManagerDelegate, WCSessionDelegate, HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
    @Published var workoutOn = false
    private let health = HKHealthStore()
    private var workout: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    @Published var dist: Double?
    @Published var plays: Double?
    @Published var holeLabel = "—"

    private let lm = CLLocationManager()
    private var course = "West"
    private var hole = 1
    private var pin: (Double, Double)?
    private var wx: [String: Double] = [:]
    private var wxTime: Date?
    private var stream = false
    private var last: CLLocation?
    private var holes: [String: [[String: Any]]] = [:]
    private var dem: [UInt16] = []
    private var demMeta: [String: Double] = [:]
    private var started = false
    private let yd = 1.09361

    override init() {
        super.init()
        loadData()
        course = UserDefaults.standard.string(forKey: "course") ?? "West"
        let h = UserDefaults.standard.integer(forKey: "hole")
        hole = (1...18).contains(h) ? h : 1
        updateLabel()
    }

    private func loadData() {
        if let u = Bundle.main.url(forResource: "course_watch", withExtension: "json"),
           let d = try? Data(contentsOf: u),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            holes["West"] = j["West"] as? [[String: Any]] ?? []
            holes["East"] = j["East"] as? [[String: Any]] ?? []
            if let dm = j["dem"] as? [String: Any] {
                for (k, v) in dm { if let n = v as? NSNumber { demMeta[k] = n.doubleValue } }
            }
        }
        if let u = Bundle.main.url(forResource: "dem", withExtension: "bin"), let d = try? Data(contentsOf: u) {
            dem = d.withUnsafeBytes { raw in Array(raw.bindMemory(to: UInt16.self)) }
        }
    }

    func start() {
        guard !started else { return }
        started = true
        lm.delegate = self
        lm.desiredAccuracy = kCLLocationAccuracyBest
        lm.distanceFilter = kCLDistanceFilterNone
        lm.activityType = .fitness
        lm.requestWhenInUseAuthorization()
        lm.startUpdatingLocation()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
        fetchWeather()
        startWorkout()
    }

    // MARK: - Golf workout: keeps the app on screen and the GPS live for the whole round
    func startWorkout() {
        guard HKHealthStore.isHealthDataAvailable(), workout == nil else { return }
        health.requestAuthorization(toShare: [HKObjectType.workoutType()], read: []) { _, _ in
            DispatchQueue.main.async { self.beginSession() }
        }
    }

    private func beginSession() {
        guard workout == nil else { return }
        let cfg = HKWorkoutConfiguration()
        cfg.activityType = .golf
        cfg.locationType = .outdoor
        do {
            let s = try HKWorkoutSession(healthStore: health, configuration: cfg)
            let b = s.associatedWorkoutBuilder()
            b.dataSource = HKLiveWorkoutDataSource(healthStore: health, workoutConfiguration: cfg)
            s.delegate = self
            b.delegate = self
            workout = s
            builder = b
            let now = Date()
            s.startActivity(with: now)
            b.beginCollection(withStart: now) { _, _ in }
            workoutOn = true
        } catch {
            workoutOn = false
        }
    }

    func endWorkout() {
        guard let s = workout else { return }
        s.end()
        builder?.endCollection(withEnd: Date()) { _, _ in
            self.builder?.finishWorkout { _, _ in }
        }
        workout = nil
        DispatchQueue.main.async { self.workoutOn = false }
    }

    func toggleWorkout() { workoutOn ? endWorkout() : startWorkout() }

    func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState,
                        from fromState: HKWorkoutSessionState, date: Date) {
        DispatchQueue.main.async { self.workoutOn = (toState == .running) }
    }
    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        DispatchQueue.main.async { self.workoutOn = false; self.workout = nil }
    }
    func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {}
    func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    func step(_ d: Int) {
        hole = (hole - 1 + d + 18) % 18 + 1
        pin = nil
        UserDefaults.standard.set(hole, forKey: "hole")
        updateLabel()
        recompute()
    }

    private func holeInfo() -> [String: Any]? {
        let arr = holes[course] ?? []
        return hole - 1 < arr.count ? arr[hole - 1] : nil
    }

    private func pinPoint() -> (Double, Double)? {
        if let p = pin { return p }
        if let g = holeInfo()?["g"] as? [NSNumber], g.count == 2 { return (g[0].doubleValue, g[1].doubleValue) }
        return nil
    }

    private func updateLabel() {
        let par = (holeInfo()?["par"] as? NSNumber)?.intValue ?? 0
        holeLabel = "\(course == "West" ? "W" : "E")\(hole) · Par \(par)"
    }

    // MARK: - Location
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways {
            manager.startUpdatingLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last, l.horizontalAccuracy >= 0 else { return }
        last = l
        recompute()
        if stream, WCSession.isSupported(), WCSession.default.isReachable {
            WCSession.default.sendMessage(["lat": l.coordinate.latitude, "lon": l.coordinate.longitude,
                                           "acc": l.horizontalAccuracy], replyHandler: nil, errorHandler: nil)
        }
        if wxTime.map({ Date().timeIntervalSince($0) > 600 }) ?? true { fetchWeather() }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    // MARK: - Math (same rules as the phone app)
    private func meters(_ a: (Double, Double), _ b: (Double, Double)) -> Double {
        let kx = 111320 * cos(a.0 * .pi / 180), ky = 110540.0
        return hypot((b.1 - a.1) * kx, (b.0 - a.0) * ky)
    }

    private func bearing(_ a: (Double, Double), _ b: (Double, Double)) -> Double {
        let kx = 111320 * cos(a.0 * .pi / 180), ky = 110540.0
        let deg = atan2((b.1 - a.1) * kx, (b.0 - a.0) * ky) * 180 / .pi
        return (deg + 360).truncatingRemainder(dividingBy: 360)
    }

    private func elevationFt(_ p: (Double, Double)) -> Double? {
        guard let n = demMeta["n"], let s = demMeta["s"], let w = demMeta["w"], let e = demMeta["e"],
              let rowsD = demMeta["rows"], let colsD = demMeta["cols"], !dem.isEmpty,
              p.0 <= n, p.0 >= s, p.1 >= w, p.1 <= e else { return nil }
        let rows = Int(rowsD), cols = Int(colsD)
        let base = demMeta["base"] ?? 130, scale = demMeta["scale"] ?? 0.01
        let r = (n - p.0) / (n - s) * Double(rows - 1), q = (p.1 - w) / (e - w) * Double(cols - 1)
        let r0 = min(rows - 2, Int(r)), q0 = min(cols - 2, Int(q))
        let fr = r - Double(r0), fq = q - Double(q0)
        func g(_ a: Int, _ b: Int) -> Double { Double(dem[a * cols + b]) }
        let v = g(r0, q0) * (1 - fr) * (1 - fq) + g(r0, q0 + 1) * (1 - fr) * fq
              + g(r0 + 1, q0) * fr * (1 - fq) + g(r0 + 1, q0 + 1) * fr * fq
        return (base + v * scale) * 3.28084
    }

    private func airDensity(_ tF: Double, _ hPa: Double, _ rh: Double) -> Double {
        let t = (tF - 32) * 5 / 9
        let es = 6.1078 * pow(10, 7.5 * t / (t + 237.3)), pv = rh / 100 * es, pd = hPa - pv
        return (pd * 100) / (287.058 * (t + 273.15)) + (pv * 100) / (461.495 * (t + 273.15))
    }

    private func recompute() {
        guard let l = last, let p = pinPoint() else { dist = nil; plays = nil; return }
        let from = (l.coordinate.latitude, l.coordinate.longitude)
        let d = meters(from, p) * yd
        var total = d
        if let e1 = elevationFt(from), let e2 = elevationFt(p) {
            let dh = e2 - e1
            total += dh / 3 * (dh > 0 ? 1 : 0.9)
        }
        if let t = wx["t"], let rh = wx["rh"], let pr = wx["p"], d > 15 {
            total += d * 0.55 * (airDensity(t, pr, rh) / airDensity(70, 1013.25, 50) - 1)
        }
        if let ws = wx["ws"], let wd = wx["wd"], d > 15 {
            let rel = (wd - bearing(from, p)) * .pi / 180
            let head = ws * cos(rel), scale = min(1, d / 120)
            total += (head > 0 ? 0.01 : 0.005) * head * d * scale
        }
        dist = d
        plays = total
    }

    // MARK: - Weather fallback (when the phone hasn't sent any)
    private func fetchWeather() {
        let p = last.map { ($0.coordinate.latitude, $0.coordinate.longitude) } ?? (32.86, -97.058)
        let s = "https://api.open-meteo.com/v1/forecast?latitude=\(p.0)&longitude=\(p.1)&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph"
        guard let url = URL(string: s) else { return }
        wxTime = Date()
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let c = j["current"] as? [String: Any] else { return }
            func n(_ k: String) -> Double? { (c[k] as? NSNumber)?.doubleValue }
            DispatchQueue.main.async {
                if let v = n("temperature_2m") { self.wx["t"] = v }
                if let v = n("relative_humidity_2m") { self.wx["rh"] = v }
                if let v = n("surface_pressure") { self.wx["p"] = v }
                if let v = n("wind_speed_10m") { self.wx["ws"] = v }
                if let v = n("wind_direction_10m") { self.wx["wd"] = v }
                self.recompute()
            }
        }.resume()
    }

    // MARK: - From the iPhone app
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let ctx = session.receivedApplicationContext
        DispatchQueue.main.async { self.apply(ctx) }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        DispatchQueue.main.async { self.apply(applicationContext) }
    }

    private func apply(_ ctx: [String: Any]) {
        guard !ctx.isEmpty else { return }
        if let c = ctx["course"] as? String { course = c; UserDefaults.standard.set(c, forKey: "course") }
        if let h = (ctx["hole"] as? NSNumber)?.intValue, (1...18).contains(h) { hole = h; UserDefaults.standard.set(h, forKey: "hole") }
        if let p = ctx["pin"] as? [NSNumber], p.count == 2 { pin = (p[0].doubleValue, p[1].doubleValue) }
        if let w = ctx["wx"] as? [String: Any] {
            for (k, v) in w { if let n = v as? NSNumber { wx[k] = n.doubleValue } }
            wxTime = Date()
        }
        stream = (ctx["streamGPS"] as? NSNumber)?.boolValue ?? false
        updateLabel()
        recompute()
    }
}
