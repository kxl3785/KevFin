import SwiftUI
import Charts

struct InvestmentsView: View {
    @Environment(AppSettings.self) private var settings
    @State private var model = InvestmentsViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if !settings.isConfigured {
                    NotConfiguredView()
                } else {
                    content
                }
            }
            .navigationTitle("Investments")
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
            if let allocation = model.allocation, allocation.total > 0 {
                loaded(allocation)
            } else {
                ContentUnavailableView("No Holdings", systemImage: "chart.pie",
                                       description: Text("Connect a brokerage account in KevFin to see your allocation."))
            }
        }
    }

    private func loaded(_ allocation: Allocation) -> some View {
        List {
            Section {
                VStack(spacing: 12) {
                    AllocationDonut(slices: model.assetClasses)
                        .frame(height: 220)
                    Text(CurrencyFormat.whole(allocation.total))
                        .font(.title2.weight(.semibold))
                        .monospacedDigit()
                    Text("Total portfolio")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
                .listRowBackground(Color.clear)
            }

            if !model.holdings.isEmpty {
                Section {
                    NavigationLink {
                        HoldingsList(holdings: model.holdings)
                    } label: {
                        Label("All holdings", systemImage: "list.bullet")
                            .badge(model.holdings.count)
                    }
                }
            }

            Section("By asset class") {
                ForEach(model.assetClasses) { slice in
                    SliceRow(slice: slice)
                }
            }

            if !model.topSectors.isEmpty {
                Section("By sector") {
                    ForEach(model.topSectors) { slice in
                        SliceRow(slice: slice)
                    }
                }
            }
        }
        .refreshable { await reload() }
    }

    private func reload() async {
        guard let url = settings.baseURL else { return }
        await model.load(using: url)
    }
}

private struct AllocationDonut: View {
    let slices: [AllocationSlice]

    var body: some View {
        Chart(slices) { slice in
            SectorMark(
                angle: .value("Value", slice.value),
                innerRadius: .ratio(0.62),
                angularInset: 1.5
            )
            .cornerRadius(3)
            .foregroundStyle(by: .value("Class", slice.name))
        }
        .chartLegend(.hidden)
    }
}

private struct SliceRow: View {
    let slice: AllocationSlice
    var body: some View {
        HStack {
            Text(slice.name)
            Spacer()
            Text(slice.percentText)
                .foregroundStyle(.secondary)
                .monospacedDigit()
            Text(CurrencyFormat.whole(slice.value))
                .monospacedDigit()
                .frame(minWidth: 90, alignment: .trailing)
        }
    }
}

/// Full, scrollable list of individual positions, reached from the
/// "All holdings" row on the Investments screen.
struct HoldingsList: View {
    let holdings: [Holding]

    var body: some View {
        List(holdings) { holding in
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(holding.symbol.isEmpty ? holding.name : holding.symbol)
                        .fontWeight(.medium)
                    Text(holding.assetClass)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(CurrencyFormat.whole(holding.value))
                        .monospacedDigit()
                    Text(holding.percentText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
        }
        .navigationTitle("Holdings")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    InvestmentsView()
        .environment(AppSettings())
}
