import SwiftUI

@main
struct BearCreekWatchApp: App {
    @StateObject private var model = WatchModel()
    var body: some Scene {
        WindowGroup {
            TabView {
                WatchView()
                HazardView()
            }
            .tabViewStyle(.page)
            .environmentObject(model)
        }
    }
}

struct WatchView: View {
    @EnvironmentObject var m: WatchModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { m.step(-1) } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.plain).frame(width: 28, height: 24)
                Spacer()
                Text(m.holeLabel).font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                Button { m.step(1) } label: { Image(systemName: "chevron.right") }
                    .buttonStyle(.plain).frame(width: 28, height: 24)
            }
            Spacer(minLength: 0)
            Text(m.dist.map { String(Int($0.rounded())) } ?? "--")
                .font(.system(size: 72, weight: .heavy, design: .rounded))
                .foregroundStyle(Color(red: 0.30, green: 0.76, blue: 0.48))
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(m.plays.map { String(Int($0.rounded())) } ?? "--")
                .font(.system(size: 46, weight: .bold, design: .rounded))
                .foregroundStyle(Color(red: 0.94, green: 0.71, blue: 0.24))
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Spacer(minLength: 0)
            Button { m.toggleWorkout() } label: {
                Text(m.workoutOn ? "● Live · End round" : "Start round")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(m.workoutOn ? Color.green : Color.orange)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 4)
        .onAppear { m.start() }
    }
}

/// Swipe left: bunkers and water within 300 yards — reach (plays) / carry (plays)
struct HazardView: View {
    @EnvironmentObject var m: WatchModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                Text("HAZARDS · \(m.holeLabel)").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                if m.hazards.isEmpty {
                    Text("None within 300 yds").font(.system(size: 14)).foregroundStyle(.secondary)
                }
                ForEach(m.hazards) { h in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(h.name).font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(h.name.hasPrefix("Water") ? Color.cyan : Color(red: 0.91, green: 0.83, blue: 0.6))
                        HStack(spacing: 4) {
                            Text("\(Int(h.reach.rounded()))").font(.system(size: 20, weight: .bold, design: .rounded))
                            Text("(\(Int(h.reachPl.rounded())))").font(.system(size: 14, weight: .semibold)).foregroundStyle(.orange)
                            Text("/").foregroundStyle(.secondary)
                            Text("\(Int(h.carry.rounded()))").font(.system(size: 20, weight: .bold, design: .rounded))
                            Text("(\(Int(h.carryPl.rounded())))").font(.system(size: 14, weight: .semibold)).foregroundStyle(.orange)
                        }
                    }
                    Divider()
                }
                Text("reach (plays) / carry (plays)").font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
    }
}
