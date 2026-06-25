import XCTest
@testable import KevFin

/// Logic-only unit tests for the pure (non-UI) layer: model decoding,
/// projection math, range filtering, and formatting. These run on the iOS
/// Simulator via `xcodebuild test`.
final class KevFinTests: XCTestCase {

    /// A decoder configured the way `APIClient` configures it.
    private func apiDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    // MARK: - Decoding

    func testNetWorthPointDecodesSnakeCase() throws {
        let json = """
        {"date":"2026-06-25","accounts_total":1000.5,"real_estate_total":250.0,"net_worth":1250.5}
        """.data(using: .utf8)!
        let point = try apiDecoder().decode(NetWorthPoint.self, from: json)
        XCTAssertEqual(point.date, "2026-06-25")
        XCTAssertEqual(point.accountsTotal, 1000.5, accuracy: 0.0001)
        XCTAssertEqual(point.realEstateTotal, 250.0, accuracy: 0.0001)
        XCTAssertEqual(point.netWorth, 1250.5, accuracy: 0.0001)
        XCTAssertNotNil(point.day)
    }

    func testAllocationIgnoresUnknownKeys() throws {
        let json = """
        {
          "total": 1000,
          "holdings": [
            {"symbol":"VTI","name":"Vanguard Total","value":600,"pct":0.6,"assetClass":"US Equity","overridden":false,"accounts":[]}
          ],
          "byAssetClass": [{"name":"US Equity","value":600,"pct":0.6,"contributors":[]}],
          "bySector": [{"name":"Tech","value":300,"pct":0.3,"contributors":[]}],
          "byStock": [], "byCountry": [], "assetClasses": ["US Equity"], "realEstate": []
        }
        """.data(using: .utf8)!
        let alloc = try apiDecoder().decode(Allocation.self, from: json)
        XCTAssertEqual(alloc.total, 1000, accuracy: 0.0001)
        XCTAssertEqual(alloc.holdings.count, 1)
        XCTAssertEqual(alloc.holdings.first?.symbol, "VTI")
        XCTAssertEqual(alloc.byAssetClass.first?.name, "US Equity")
        XCTAssertEqual(alloc.bySector.first?.name, "Tech")
    }

    func testTaxAccountIdAcceptsNumberOrString() throws {
        let numeric = #"{"id":5,"name":"401k","org_name":"Fidelity","balance":100,"bucket":"pretax"}"#.data(using: .utf8)!
        let stringy = #"{"id":"abc","name":"HSA","org_name":"Lively","balance":50,"bucket":"hsa"}"#.data(using: .utf8)!
        let a = try apiDecoder().decode(TaxAccount.self, from: numeric)
        let b = try apiDecoder().decode(TaxAccount.self, from: stringy)
        XCTAssertEqual(a.id, "5")
        XCTAssertEqual(a.orgName, "Fidelity")
        XCTAssertEqual(b.id, "abc")
    }

    // MARK: - Forecast projection

    func testProjectionCompoundsWithContributions() {
        // 1000 → year1: 1000*1.1 + 100 = 1200 → year2: 1200*1.1 + 100 = 1420
        let v = ForecastViewModel.project(principal: 1000, years: 2, annualReturn: 0.1, annualContribution: 100)
        XCTAssertEqual(v, 1420, accuracy: 0.0001)
    }

    func testProjectionZeroYearsReturnsPrincipal() {
        let v = ForecastViewModel.project(principal: 5000, years: 0, annualReturn: 0.07, annualContribution: 1000)
        XCTAssertEqual(v, 5000, accuracy: 0.0001)
    }

    // MARK: - Chart range filtering

    func testOneMonthRangeKeepsRecentPointsOnly() {
        let points = [
            NetWorthPoint(date: "2026-01-01", accountsTotal: 0, realEstateTotal: 0, netWorth: 100),
            NetWorthPoint(date: "2026-03-01", accountsTotal: 0, realEstateTotal: 0, netWorth: 200),
            NetWorthPoint(date: "2026-06-01", accountsTotal: 0, realEstateTotal: 0, netWorth: 300),
            NetWorthPoint(date: "2026-06-20", accountsTotal: 0, realEstateTotal: 0, netWorth: 400),
            NetWorthPoint(date: "2026-06-25", accountsTotal: 0, realEstateTotal: 0, netWorth: 500),
        ]
        // Window anchored on the last point (2026-06-25); cutoff ≈ 2026-05-26.
        XCTAssertEqual(ChartRange.oneMonth.filter(points).count, 3)
        XCTAssertEqual(ChartRange.all.filter(points).count, 5)
    }

    // MARK: - Formatting

    func testSignedWholeUsesExplicitSign() {
        XCTAssertTrue(CurrencyFormat.signedWhole(1234).hasPrefix("+"))
        XCTAssertTrue(CurrencyFormat.signedWhole(-1234).hasPrefix("\u{2212}")) // U+2212 minus
    }

    // MARK: - Budget category

    func testAnnualCategoryMeasuresAgainstYearToDate() {
        let cat = BudgetCategory(category: "Travel", spent: 100, count: 1, target: 1200,
                                 period: "annual", ytdSpent: 1500, excluded: false)
        XCTAssertTrue(cat.isAnnual)
        XCTAssertEqual(cat.effectiveSpent, 1500, accuracy: 0.0001) // YTD, not the month's 100
        XCTAssertTrue(cat.isOverBudget)
        XCTAssertEqual(cat.progress, 1.0, accuracy: 0.0001) // clamped
    }

    func testMonthlyCategoryProgressIsFraction() {
        let cat = BudgetCategory(category: "Groceries", spent: 300, count: 5, target: 600,
                                 period: "monthly", ytdSpent: nil, excluded: false)
        XCTAssertFalse(cat.isOverBudget)
        XCTAssertEqual(cat.progress, 0.5, accuracy: 0.0001)
    }
}
