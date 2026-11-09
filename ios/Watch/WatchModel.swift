import Foundation
import CoreLocation
import WatchConnectivity
import HealthKit
import CoreMotion
import WidgetKit
import WatchKit

struct Hazard: Identifiable {
    let id: Int
    let name: String
    let reach: Double, reachPl: Double, carry: Double, carryPl: Double
}

/// Live distance + plays-like on the watch, from the watch's own GPS.
/// Hole, pin and weather come from the iPhone app; the watch falls back to its bundled course data.
final class WatchModel: NSObject, ObservableObject, CLLocationManagerDelegate, WCSessionDelegate, HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
    @Published var workoutOn = false
    private let health = HKHealthStore()
    private var workout: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    @Published var dist: Double?
    @Published var hazards: [Hazard] = []
    @Published var front: (Double, Double)?   // (yards, plays-like)
    @Published var back: (Double, Double)?
    @Published var pinSet = false
    @Published var page = 0 { didSet { pageAt = Date() } }
    @Published var resetTick = 0
    private var pageAt = Date()
    private var detailAt: Date?
    private var lastSwing = Date.distantPast
    private let motion = CMMotionManager()
    private var ticker: Timer?
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
    private var roaming = false
    private var active = true
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
        setActive(true)
    }

    /// Screen on (wrist raised) = full speed; wrist down = ticker and swing sensor off, GPS relaxed. Big battery saver over a round.
    func setActive(_ on: Bool) {
        active = on
        ticker?.invalidate(); ticker = nil
        motion.stopDeviceMotionUpdates()
        if on {
            ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
            if motion.isDeviceMotionAvailable {
                motion.deviceMotionUpdateInterval = 1.0 / 20
                motion.startDeviceMotionUpdates(to: .main) { [weak self] dm, _ in
                    guard let self = self, let r = dm?.rotationRate else { return }
                    // a golf swing spins the wrist far faster than walking or riding
                    if sqrt(r.x * r.x + r.y * r.y + r.z * r.z) > 12, Date().timeIntervalSince(self.lastSwing) > 3 {
                        self.lastSwing = Date()
                        self.resetView()
                    }
                }
            }
            lm.desiredAccuracy = kCLLocationAccuracyBest
            lm.distanceFilter = roaming ? 5 : kCLDistanceFilterNone
        } else if stream {          // phone is showing our GPS: keep accuracy, just fewer fixes
            lm.distanceFilter = 5
        } else {
            lm.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
            lm.distanceFilter = 15
        }
    }

    /// Front/back rows scrolled into view
    func detailShown() { detailAt = Date() }

    /// Snap back to the big pin number: after 10 s on another page / scrolled down, or after a swing
    func resetView() {
        detailAt = nil
        if page != 0 { page = 0 }
        resetTick += 1
    }

    private func tick() {
        let now = Date()
        if page != 0 && now.timeIntervalSince(pageAt) > 10 { resetView() }
        else if let d = detailAt, now.timeIntervalSince(d) > 10 { resetView() }
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
            let ds = HKLiveWorkoutDataSource(healthStore: health, workoutConfiguration: cfg)
            ds.disableCollection(for: HKQuantityType(.heartRate))   // not needed: saves battery
            ds.disableCollection(for: HKQuantityType(.activeEnergyBurned))
            b.dataSource = ds
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
        pinSet = false
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
        // power: walking/riding between shots needs fewer fixes; standing at the ball gets full accuracy and every fix
        let sp = l.speed >= 0 ? l.speed : 0
        if sp > 1.3, !roaming {
            roaming = true; if active { manager.distanceFilter = 5 }
        } else if sp < 1.0, roaming {
            roaming = false; if active { manager.distanceFilter = kCLDistanceFilterNone }
        }
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

    /// returns (yards, plays-like yards) from -> to
    private func playsLike(_ from: (Double, Double), _ to: (Double, Double)) -> (Double, Double) {
        let d = meters(from, to) * yd
        var total = d
        if let e1 = elevationFt(from), let e2 = elevationFt(to) {
            let dh = e2 - e1
            total += dh / 3 * (dh > 0 ? 1 : 0.9)
        }
        if let t = wx["t"], let rh = wx["rh"], let pr = wx["p"], d > 15 {
            total += d * 0.55 * (airDensity(t, pr, rh) / airDensity(70, 1013.25, 50) - 1)
        }
        if let ws = wx["ws"], let wd = wx["wd"], d > 15 {
            let rel = (wd - bearing(from, to)) * .pi / 180
            let head = ws * cos(rel), scale = min(1, d / 120)
            total += (head > 0 ? 0.01 : 0.005) * head * d * scale
        }
        return (d, total)
    }

    // local flat-earth x/y in meters around an origin
    private func xy(_ p: (Double, Double), _ o: (Double, Double)) -> (Double, Double) {
        ((p.1 - o.1) * 111320 * cos(o.0 * .pi / 180), (p.0 - o.0) * 110540)
    }
    private func fromXY(_ v: (Double, Double), _ o: (Double, Double)) -> (Double, Double) {
        (o.0 + v.1 / 110540, o.1 + v.0 / (111320 * cos(o.0 * .pi / 180)))
    }

    private func computeHazards(_ from: (Double, Double), _ pin: (Double, Double)) -> [Hazard] {
        guard let list = holeInfo()?["hz"] as? [[String: Any]] else { return [] }
        let pv = xy(pin, from), D = hypot(pv.0, pv.1)
        guard D > 1 else { return [] }
        let u = (pv.0 / D, pv.1 / D)
        var out: [Hazard] = []
        for (idx, z) in list.enumerated() {
            guard let raw = z["p"] as? [[NSNumber]], raw.count > 2 else { continue }
            let poly = raw.map { ($0[0].doubleValue, $0[1].doubleValue) }
            let pts = poly.map { xy($0, from) }
            let c = (pts.map { $0.0 }.reduce(0, +) / Double(pts.count), pts.map { $0.1 }.reduce(0, +) / Double(pts.count))
            let proj = c.0 * u.0 + c.1 * u.1
            if proj < -5 || proj > D + 25 { continue }           // only hazards ahead of you
            var best = (1e9, (0.0, 0.0)), far = (0.0, (0.0, 0.0))
            for k in 0..<(pts.count - 1) {
                let a = pts[k], b = pts[k + 1], dx = b.0 - a.0, dy = b.1 - a.1, L = dx * dx + dy * dy
                let t = L > 0 ? max(0, min(1, -(a.0 * dx + a.1 * dy) / L)) : 0
                let q = (a.0 + t * dx, a.1 + t * dy), dq = hypot(q.0, q.1)
                if dq < best.0 { best = (dq, q) }
            }
            for q in pts { let dq = hypot(q.0, q.1); if dq > far.0 { far = (dq, q) } }
            let reachYd = best.0 * yd
            if reachYd > 300 || reachYd < 3 { continue }       // within 300 yards
            let side = u.0 * c.1 - u.1 * c.0
            let lat = abs(side) < 8 ? "C" : (side > 0 ? "L" : "R")
            let isBunker = (z["t"] as? String) == "b"
            let rp = playsLike(from, fromXY(best.1, from)), cp = playsLike(from, fromXY(far.1, from))
            out.append(Hazard(id: idx, name: (isBunker ? "Bunker " : "Water ") + lat,
                              reach: rp.0, reachPl: rp.1, carry: cp.0, carryPl: cp.1))
        }
        return out.sorted { $0.reach < $1.reach }
    }

    private func recompute() {
        guard let l = last, let p = pinPoint() else { dist = nil; plays = nil; hazards = []; front = nil; back = nil; return }
        let from = (l.coordinate.latitude, l.coordinate.longitude)
        let r = playsLike(from, p)
        dist = r.0
        plays = r.1
        hazards = computeHazards(from, p)
        if let fb = frontBack(from, p) {
            front = playsLike(from, fb.0)
            back = playsLike(from, fb.1)
        } else { front = nil; back = nil }
        shareToComplication()
    }

    private var lastShare = Date.distantPast
    private func shareToComplication() {
        guard let d = WatchShare.defaults, let m = dist else { return }
        d.set(hole, forKey: "hole"); d.set(Int(m.rounded()), forKey: "mid")
        d.set(Int((front?.0 ?? 0).rounded()), forKey: "front"); d.set(Int((back?.0 ?? 0).rounded()), forKey: "back")
        d.set(Date().timeIntervalSince1970, forKey: "ts")
        if Date().timeIntervalSince(lastShare) > 20 { lastShare = Date(); WidgetCenter.shared.reloadAllTimelines() }
    }

    /// front / back edge of the green along your line to the pin
    private func frontBack(_ from: (Double, Double), _ pin: (Double, Double)) -> ((Double, Double), (Double, Double))? {
        guard let raw = holeInfo()?["gp"] as? [[NSNumber]], raw.count > 2 else { return nil }
        let pts = raw.map { xy(($0[0].doubleValue, $0[1].doubleValue), from) }
        let pv = xy(pin, from), D = hypot(pv.0, pv.1)
        guard D > 1 else { return nil }
        let d = (pv.0 / D, pv.1 / D)
        var hits: [Double] = []
        for k in 0..<(pts.count - 1) {
            let a = pts[k], b = pts[k + 1], e = (b.0 - a.0, b.1 - a.1)
            let den = d.0 * e.1 - d.1 * e.0
            if abs(den) < 1e-9 { continue }
            let s = (a.0 * e.1 - a.1 * e.0) / den, u = (a.0 * d.1 - a.1 * d.0) / den
            if u >= 0 && u <= 1 && s > 0 { hits.append(s) }
        }
        if hits.count >= 2, let lo = hits.min(), let hi = hits.max() {
            return (fromXY((d.0 * lo, d.1 * lo), from), fromXY((d.0 * hi, d.1 * hi), from))
        }
        // standing on/inside the green: nearest and farthest edge points
        let near = pts.min { hypot($0.0, $0.1) < hypot($1.0, $1.1) }!, far = pts.max { hypot($0.0, $0.1) < hypot($1.0, $1.1) }!
        return (fromXY(near, from), fromXY(far, from))
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

    // MARK: - One-tap shot
    @Published var shotCount = -1      // -1 = no round running on the phone
    @Published var shotFlash = false
    func logShot() {
        let msg: [String: Any] = ["cmd": "shot"]
        if WCSession.default.isReachable { WCSession.default.sendMessage(msg, replyHandler: nil, errorHandler: nil) }
        else { WCSession.default.transferUserInfo(msg) }
        if shotCount >= 0 { shotCount += 1 }
        WKInterfaceDevice.current().play(.success)
        shotFlash = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.shotFlash = false }
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
        pinSet = (ctx["pinSet"] as? NSNumber)?.boolValue ?? false
        if let w = ctx["wx"] as? [String: Any] {
            for (k, v) in w { if let n = v as? NSNumber { wx[k] = n.doubleValue } }
            wxTime = Date()
        }
        shotCount = (ctx["shots"] as? NSNumber)?.intValue ?? -1
        stream = (ctx["streamGPS"] as? NSNumber)?.boolValue ?? false
        updateLabel()
        recompute()
    }
}
