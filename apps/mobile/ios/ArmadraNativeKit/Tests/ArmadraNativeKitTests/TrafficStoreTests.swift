import ArmadraNativeKit
import XCTest

final class TrafficStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "dev.armadra.mobile.tests.traffic"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    private func row(
        day: String = "2026-10-12", source: String = "src1", category: String = "api",
        bytesIn: Int = 1, bytesOut: Int = 2, streams: Int = 3
    ) -> [String: Any] {
        ["day": day, "sourceId": source, "category": category,
         "bytesIn": bytesIn, "bytesOut": bytesOut, "streams": streams]
    }

    func testSavedRowsComeBackWholeAndANewSaveReplacesThem() {
        let store = TrafficStore(defaults: defaults)
        XCTAssertTrue(store.load().isEmpty)
        XCTAssertTrue(store.save([row(), row(source: "src2", bytesIn: 9)]))
        let loaded = store.load()
        XCTAssertEqual(loaded.count, 2)
        XCTAssertEqual(loaded[1]["sourceId"] as? String, "src2")
        XCTAssertEqual((loaded[1]["bytesIn"] as? NSNumber)?.intValue, 9)
        XCTAssertTrue(store.save([row(source: "only")]))
        XCTAssertEqual(store.load().count, 1)
    }

    func testABadRowRejectsTheWholeSaveAndKeepsTheHistory() {
        let store = TrafficStore(defaults: defaults)
        XCTAssertTrue(store.save([row()]))
        XCTAssertFalse(store.save([row(), row(day: "yesterday")]))
        XCTAssertFalse(store.save([row(source: "../x")]))
        XCTAssertFalse(store.save([row(bytesIn: -1)]))
        XCTAssertFalse(store.save([row(category: "")]))
        XCTAssertFalse(store.save([["day": "2026-10-12"]]))
        XCTAssertEqual(store.load().count, 1)
    }

    func testTooManyRowsAreRefused() {
        let rows = (0...TrafficRows.maxRows).map { _ in row() }
        XCTAssertNil(TrafficRows.checked(rows))
        XCTAssertNotNil(TrafficRows.checked(Array(rows.dropFirst())))
    }

    func testBrokenStoredTextReadsAsEmpty() {
        defaults.set("not json", forKey: TrafficStore.defaultKey)
        XCTAssertTrue(TrafficStore(defaults: defaults).load().isEmpty)
    }
}
