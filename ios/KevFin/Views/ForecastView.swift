import SwiftUI

struct ForecastView: View {
    @Environment(AppSettings.self) private var settings
    @State private var model = ForecastViewModel()

    // Projection inputs.
    @State private var years: Double = 20
    @State private var annualReturnPct: Double = 6
    @State private var contributionOverride: Double?

    var body: some View {
        NavigationStack {
            Group {
                if !settings.isConfigured {
                    NotConfiguredView()
                } else {
                    content
                }
            }
            .navigationTitle("Forecast")
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
            if let buckets = model.taxBuckets {
                loaded(buckets)
            } else {
                ContentUnavailableView("No Forecast Data", systemImage: "chart.xyaxis.line")
            }
        }
    }

    private func loaded(_ buckets: TaxBuckets) -> some View {
        let principal = buckets.grandTotal
        let contribution = contributionOverride ?? model.projection?.estimatedAnnualSavings ?? 0
        let projected = ForecastViewModel.project(
            principal: principal,
            years: Int(years),
            annualReturn: annualReturnPct / 100,
            annualContribution: contribution
        )

        return List {
            Section("Investable assets") {
                ForEach(buckets.orderedTotals.filter { $0.total != 0 }, id: \.bucket) { item in
                    HStack {
                        Text(BucketLabel.display(item.bucket))
                        Spacer()
                        Text(CurrencyFormat.whole(item.total))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
                HStack {
                    Text("Total").fontWeight(.semibold)
                    Spacer()
                    Text(CurrencyFormat.whole(principal))
                        .fontWeight(.semibold)
                        .monospacedDigit()
                }
            }

            Section("Assumptions") {
                slider(title: "Years", value: $years, range: 1...40, step: 1, format: "\(Int(years)) yr")
                slider(title: "Annual return", value: $annualReturnPct, range: 0...12, step: 0.5,
                       format: annualReturnPct.formatted(.number.precision(.fractionLength(1))) + "%")
                contributionSlider(default: model.projection?.estimatedAnnualSavings ?? 0)
            }

            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Projected in \(Int(years)) years")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(CurrencyFormat.whole(projected))
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .contentTransition(.numericText())
                }
                .padding(.vertical, 4)
            } footer: {
                Text("A simple deterministic estimate: today's investable assets compounded at a fixed annual return plus a flat yearly contribution. KevFin's full Monte Carlo retirement model — with tax buckets, spending, and 400 market paths — lives in the web app.")
            }
        }
        .refreshable { await reload() }
    }

    private func slider(title: String, value: Binding<Double>, range: ClosedRange<Double>, step: Double, format: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title)
                Spacer()
                Text(format).foregroundStyle(.secondary).monospacedDigit()
            }
            Slider(value: value, in: range, step: step)
        }
    }

    private func contributionSlider(default defaultValue: Double) -> some View {
        let binding = Binding<Double>(
            get: { contributionOverride ?? defaultValue },
            set: { contributionOverride = $0 }
        )
        return VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text("Annual contribution")
                Spacer()
                Text(CurrencyFormat.whole(binding.wrappedValue))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Slider(value: binding, in: 0...200_000, step: 1_000)
            if contributionOverride == nil && defaultValue > 0 {
                Text("Seeded from your recent income minus spending.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func reload() async {
        guard let url = settings.baseURL else { return }
        await model.load(using: url)
    }
}

#Preview {
    ForecastView()
        .environment(AppSettings())
}
