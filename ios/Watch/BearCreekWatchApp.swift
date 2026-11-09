import SwiftUI

@main
struct BearCreekWatchApp: App {
    @StateObject private var model = WatchModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            WatchRoot().environmentObject(model)
                .onChange(of: phase) { _, p in model.setActive(p == .active) }
        }
    }
}

let greenNum = Color(red: 0.30, green: 0.76, blue: 0.48)
let playsNum = Color(red: 0.94, green: 0.71, blue: 0.24)
func yds(_ v: Double?) -> String { v.map { String(Int($0.rounded())) } ?? "--" }

/// Swipe left for hazards. Snaps back to the big number after 10 s or a swing.
struct WatchRoot: View {
    @EnvironmentObject var m: WatchModel
    var body: some View {
        TabView(selection: $m.page) {
            WatchView().tag(0)
            HazardView().tag(1)
        }
        .tabViewStyle(.page)
        .onAppear { m.start() }
    }
}

/// Big pin / center number. Scroll down for front & back of the green.
struct WatchView: View {
    @EnvironmentObject var m: WatchModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    HStack {
                        Button { m.step(-1) } label: { Image(systemName: "chevron.left").font(.system(size: 18, weight: .bold)) }
                            .buttonStyle(.plain).frame(width: 34, height: 28)
                        Spacer()
                        Text(m.holeLabel).font(.system(size: 17, weight: .bold))
                        Spacer()
                        Button { m.step(1) } label: { Image(systemName: "chevron.right").font(.system(size: 18, weight: .bold)) }
                            .buttonStyle(.plain).frame(width: 34, height: 28)
                    }
                    .id("top")
                    if m.shotCount >= 0 {
                        Button { m.logShot() } label: {
                            Text(m.shotFlash ? "✓ Shot \(m.shotCount)" : "+ Shot (\(m.shotCount))")
                                .font(.system(size: 18, weight: .heavy)).frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                        .tint(Color(red: 1.0, green: 0.60, blue: 0.0)).buttonStyle(.borderedProminent).foregroundStyle(.black)
                    }
                    Text(m.pinSet ? "PIN" : "CENTER").font(.system(size: 15, weight: .heavy)).foregroundStyle(.secondary)
                    Text(yds(m.dist))
                        .font(.system(size: 92, weight: .heavy, design: .rounded))
                        .foregroundStyle(greenNum)
                        .minimumScaleFactor(0.6).lineLimit(1)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("PLAYS").font(.system(size: 15, weight: .heavy)).foregroundStyle(.secondary)
                        Text(yds(m.plays))
                            .font(.system(size: 52, weight: .heavy, design: .rounded))
                            .foregroundStyle(playsNum)
                            .minimumScaleFactor(0.6).lineLimit(1)
                    }
                    Image(systemName: "chevron.compact.down").foregroundStyle(.secondary).padding(.top, 4)
                    Group {
                        edgeRow("FRONT", m.front)
                        edgeRow("BACK", m.back)
                    }
                    .onAppear { m.detailShown() }
                    Button { m.toggleWorkout() } label: {
                        Text(m.workoutOn ? "● Live · End round" : "Start round")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(m.workoutOn ? Color.green : Color.orange)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 4)
            }
            .onChange(of: m.resetTick) { _, _ in
                withAnimation { proxy.scrollTo("top", anchor: .top) }
            }
        }
    }

    private func edgeRow(_ label: String, _ v: (Double, Double)?) -> some View {
        VStack(spacing: 0) {
            Text(label).font(.system(size: 15, weight: .heavy)).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(yds(v?.0)).font(.system(size: 54, weight: .heavy, design: .rounded))
                Text(yds(v?.1)).font(.system(size: 34, weight: .heavy, design: .rounded)).foregroundStyle(playsNum)
            }
            .minimumScaleFactor(0.6).lineLimit(1)
        }
        .padding(.vertical, 4)
    }
}

/// Swipe left: bunkers and water within 300 yards — reach (plays) / carry (plays)
struct HazardView: View {
    @EnvironmentObject var m: WatchModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("HAZARDS · \(m.holeLabel)").font(.system(size: 15, weight: .heavy)).foregroundStyle(.secondary)
                if m.hazards.isEmpty {
                    Text("None within 300 yds").font(.system(size: 18, weight: .semibold)).foregroundStyle(.secondary)
                }
                ForEach(m.hazards) { h in
                    VStack(alignment: .leading, spacing: 0) {
                        Text(h.name).font(.system(size: 17, weight: .heavy))
                            .foregroundStyle(h.name.hasPrefix("Water") ? Color.cyan : Color(red: 0.91, green: 0.83, blue: 0.6))
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text(yds(h.reach)).font(.system(size: 30, weight: .heavy, design: .rounded))
                            Text(yds(h.reachPl)).font(.system(size: 20, weight: .heavy)).foregroundStyle(playsNum)
                            Text("/").font(.system(size: 20)).foregroundStyle(.secondary)
                            Text(yds(h.carry)).font(.system(size: 30, weight: .heavy, design: .rounded))
                            Text(yds(h.carryPl)).font(.system(size: 20, weight: .heavy)).foregroundStyle(playsNum)
                        }
                        .minimumScaleFactor(0.6).lineLimit(1)
                    }
                    Divider()
                }
                Text("reach / carry · orange = plays like").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
        }
    }
}
