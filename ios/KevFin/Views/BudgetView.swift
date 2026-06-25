import SwiftUI

struct BudgetView: View {
    @Environment(AppSettings.self) private var settings
    @State private var model = BudgetViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if !settings.isConfigured {
                    NotConfiguredView()
                } else {
                    content
                }
            }
            .navigationTitle("Budget")
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
            if let summary = model.summary {
                loaded(summary)
            } else {
                ContentUnavailableView("No Budget Data", systemImage: "chart.pie")
            }
        }
    }

    private func loaded(_ summary: BudgetSummary) -> some View {
        List {
            Section {
                summaryRow("Income", summary.income, tint: .green)
                summaryRow("Spending", summary.spending, tint: .red)
                if summary.mortgage > 0 {
                    summaryRow("Mortgage", summary.mortgage, tint: .secondary)
                }
                summaryRow(summary.net >= 0 ? "Net saved" : "Net overspent",
                           abs(summary.net),
                           tint: summary.net >= 0 ? .green : .red,
                           emphasized: true)
            } header: {
                Text(monthLabel(summary.month))
            }

            Section("By category") {
                ForEach(model.spendingCategories) { category in
                    CategoryRow(category: category)
                }
            }
        }
        .refreshable { await reload() }
    }

    private func summaryRow(_ label: String, _ value: Double, tint: Color, emphasized: Bool = false) -> some View {
        HStack {
            Text(label)
                .font(emphasized ? .body.weight(.semibold) : .body)
            Spacer()
            Text(CurrencyFormat.whole(value))
                .font(emphasized ? .body.weight(.semibold) : .body)
                .monospacedDigit()
                .foregroundStyle(tint)
        }
    }

    private func monthLabel(_ month: String) -> String {
        // month is "yyyy-MM"; render as e.g. "June 2026".
        let parser = DateFormatter()
        parser.dateFormat = "yyyy-MM"
        guard let date = parser.date(from: month) else { return month }
        let out = DateFormatter()
        out.dateFormat = "MMMM yyyy"
        return out.string(from: date)
    }

    private func reload() async {
        guard let url = settings.baseURL else { return }
        await model.load(using: url)
    }
}

private struct CategoryRow: View {
    let category: BudgetCategory

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(category.category)
                if category.isAnnual {
                    Text("annual")
                        .font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.secondary.opacity(0.15), in: Capsule())
                }
                Spacer()
                Text(spentLabel)
                    .monospacedDigit()
                    .foregroundStyle(category.isOverBudget ? .red : .primary)
            }
            if category.hasTarget {
                ProgressView(value: category.progress)
                    .tint(category.isOverBudget ? .red : .accentColor)
            }
        }
        .padding(.vertical, 2)
    }

    private var spentLabel: String {
        let spent = CurrencyFormat.whole(category.effectiveSpent)
        guard category.hasTarget else { return spent }
        return "\(spent) / \(CurrencyFormat.whole(category.target))"
    }
}

#Preview {
    BudgetView()
        .environment(AppSettings())
}
