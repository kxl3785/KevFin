import SwiftUI

struct DashboardView: View {
    @Environment(AppSettings.self) private var settings
    @State private var model = DashboardViewModel()
    @State private var range: ChartRange = .oneYear
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            Group {
                if !settings.isConfigured {
                    NotConfiguredView()
                } else {
                    content
                }
            }
            .navigationTitle("Net Worth")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
            }
        }
        .task(id: settings.serverURLString) { await reload() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .idle, .loading:
            ProgressView("Loading…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ErrorView(message: message) { Task { await reload() } }
        case .loaded:
            loadedContent
        }
    }

    private var loadedContent: some View {
        let filtered = range.filter(model.history)
        return ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headline
                NetWorthChart(points: filtered)
                Picker("Range", selection: $range) {
                    ForEach(ChartRange.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            .padding()
        }
        .refreshable { await reload() }
    }

    private var headline: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(model.currentNetWorth.map(CurrencyFormat.whole) ?? "—")
                .font(.system(size: 40, weight: .bold, design: .rounded))
                .contentTransition(.numericText())
            if let change = range.filter(model.history).changeOverSeries() {
                Label(CurrencyFormat.signedWhole(change), systemImage: change < 0 ? "arrow.down.right" : "arrow.up.right")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(change < 0 ? .red : .green)
            }
        }
    }

    private func reload() async {
        guard let url = settings.baseURL else { return }
        await model.load(using: url)
    }
}

/// Time windows offered by the dashboard's segmented control.
enum ChartRange: String, CaseIterable, Identifiable {
    case oneMonth, sixMonths, oneYear, all
    var id: String { rawValue }

    var label: String {
        switch self {
        case .oneMonth:  return "1M"
        case .sixMonths: return "6M"
        case .oneYear:   return "1Y"
        case .all:       return "All"
        }
    }

    private var days: Int? {
        switch self {
        case .oneMonth:  return 30
        case .sixMonths: return 182
        case .oneYear:   return 365
        case .all:       return nil
        }
    }

    /// Keep only the points within the window, assuming `points` is ascending by date.
    func filter(_ points: [NetWorthPoint]) -> [NetWorthPoint] {
        guard let days, let last = points.last?.day else { return points }
        let cutoff = Calendar.current.date(byAdding: .day, value: -days, to: last) ?? last
        return points.filter { ($0.day ?? .distantPast) >= cutoff }
    }
}

private extension Array where Element == NetWorthPoint {
    func changeOverSeries() -> Double? {
        guard let first = first?.netWorth, let last = last?.netWorth else { return nil }
        return last - first
    }
}

#Preview {
    DashboardView()
        .environment(AppSettings())
}
