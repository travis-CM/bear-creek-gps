import SwiftUI

@main
struct BearCreekWatchApp: App {
    @StateObject private var model = WatchModel()
    var body: some Scene {
        WindowGroup {
            WatchView().environmentObject(model)
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
