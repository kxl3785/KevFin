import SwiftUI
import Charts

/// A simple area + line chart of net worth over time, built on Swift Charts.
struct NetWorthChart: View {
    let points: [NetWorthPoint]

    private struct DatedValue: Identifiable {
        let date: Date
        let value: Double
        var id: Date { date }
    }

    private var dated: [DatedValue] {
        points.compactMap { p in p.day.map { DatedValue(date: $0, value: p.netWorth) } }
    }

    var body: some View {
        Chart(dated) { item in
            AreaMark(
                x: .value("Date", item.date),
                y: .value("Net worth", item.value)
            )
            .foregroundStyle(
                .linearGradient(
                    colors: [.accentColor.opacity(0.35), .accentColor.opacity(0.02)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )

            LineMark(
                x: .value("Date", item.date),
                y: .value("Net worth", item.value)
            )
            .foregroundStyle(.accentColor)
            .interpolationMethod(.monotone)
        }
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine()
                AxisValueLabel {
                    if let dollars = value.as(Double.self) {
                        Text(dollars.formatted(.number.notation(.compactName)))
                    }
                }
            }
        }
        .frame(height: 220)
    }
}
