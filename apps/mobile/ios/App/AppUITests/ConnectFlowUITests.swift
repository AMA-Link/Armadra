import XCTest

/// B 档 UI 用例「连接 → 配对 → 画布」（补全计划 G3-1），由
/// `tools/probes/mobile-shell-e2e.mjs` 驱动：探针起 core、在回环上开 Gateway（模拟器与
/// 宿主共用回环），把原生深链 `armadra://pair?host=…&ticket=…&fp=…` 经
/// `TEST_RUNNER_ARMADRA_PAIR_LINK` 交进来，用例经深链交给 App。页面在 WKWebView 里，按无障碍树
/// 找输入框与按钮；文案中英都认（模拟器的语言不定）。还没有连接时连接页先列添加方式，
/// 「配对链接」之后才有输入框。XCTest 按名字排序：配对之后 App 记住了
/// Gateway，「没有 Gateway」那条必须在前（`test1…`、`test2…`）。连接表非空时启动先落在「选择服务」
/// （A7-1），点一行才进画布。
final class ConnectFlowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// Debug 构建认这个启动参数：不放开屏动画（`ArmadraBridgeViewController`）。
    private func launched() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ArmadraUITest"]
        app.launch()
        return app
    }

    private func button(_ app: XCUIApplication, _ labels: [String]) -> XCUIElement {
        app.webViews.buttons.matching(NSPredicate(format: "label IN %@", labels)).firstMatch
    }

    /// 系统交深链前可能先问一句「在“Armadra”中打开？」（iOS 27 模拟器第一次必问）：有就点「打开」。
    private func confirmOpenIfAsked() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let open = springboard.buttons.matching(NSPredicate(format: "label IN %@", ["打开", "Open"])).firstMatch
        if open.waitForExistence(timeout: 5) {
            open.tap()
        }
    }

    /// 深链预填了连接页的链接输入框（`armadra://pair` → `#link=`）。等不到就留一张截图。
    private func assertPrefilled(_ app: XCUIApplication, _ name: String) {
        let field = app.webViews.textFields.firstMatch
        let filled = NSPredicate(format: "value BEGINSWITH %@", "armadra://pair?")
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: filled, object: field)], timeout: 60)
        if result != .completed {
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = name
            shot.lifetime = .keepAlways
            add(shot)
            XCTFail("\(name): pairing link not prefilled (state \(app.state.rawValue))")
        }
    }

    /// 还没有连接时，连接页先列出添加方式（扫码、配对链接、个人中转），输入框在「配对链接」后面。
    private func pairingLink(_ app: XCUIApplication) -> XCUIElement {
        button(app, ["配对链接", "Pairing link"])
    }

    func test1WithoutAGatewayTheAppOpensOnTheConnectScreen() {
        let app = launched()
        let link = pairingLink(app)
        XCTAssertTrue(link.waitForExistence(timeout: 60), "connect screen")
        link.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.webViews.textFields.firstMatch.waitForExistence(timeout: 20), "pairing link input")
        XCTAssertTrue(button(app, ["连接", "Connect"]).exists)
    }

    func test2PairsThroughThePinnedGatewayAndOpensTheCanvas() throws {
        guard let link = ProcessInfo.processInfo.environment["ARMADRA_PAIR_LINK"], !link.isEmpty else {
            throw XCTSkip("ARMADRA_PAIR_LINK not given (run through tools/probes/mobile-shell-e2e.mjs)")
        }
        let url = try XCTUnwrap(URL(string: link))
        let app = launched()
        XCTAssertTrue(pairingLink(app).waitForExistence(timeout: 60), "connect screen")
        // 链接走深链交给 App（`armadra://pair` → `#link=` 预填、直接落在链接输入框）；连接页由人点
        // 「连接」。两条路都走（#281）：
        //  - 热启动：经系统打开，App 还在跑，场景收到 `openURLContexts`，改写地址重载。
        //    （`XCUIApplication.open` 不是这条：它先结束正在跑的 App 再带着链接冷启动。）
        //  - 冷启动：App 不在跑，带着链接启动，链接直接写进第一个文档（`LaunchLink`）。
        XCUIDevice.shared.system.open(url)
        confirmOpenIfAsked()
        assertPrefilled(app, "deep link while running")
        XCTAssertEqual(app.state, .runningForeground, "the app keeps running when a link arrives")
        app.terminate()
        app.open(url)
        confirmOpenIfAsked()
        assertPrefilled(app, "deep link on a cold launch")
        let connect = button(app, ["连接", "Connect"])
        XCTAssertTrue(connect.waitForExistence(timeout: 10))
        // WKWebView 里的元素常报「不可点」（无障碍树的可点判定跟不上页面布局），按坐标点。
        connect.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let canvas = button(app, ["画布", "Canvas"])
        // 深链预填之后页面还会再渲染一次，紧跟着的一次点按偶尔落空：连接页原样、按钮可点、没有
        // 错误（nightly 37235828235、37190639392 的截图）。按钮仍可点就再点，最多两次；票只用一次，
        // 真开始配对之后按钮是禁用的，不会重复兑换。
        var retries = 0
        while !canvas.waitForExistence(timeout: 20), retries < 2, connect.exists, connect.isEnabled {
            retries += 1
            XCTContext.runActivity(named: "connect tap retry \(retries)") { _ in
                connect.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
        }
        if !canvas.waitForExistence(timeout: 20) {
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.lifetime = .keepAlways
            add(shot)
            XCTFail("canvas after pairing: \(app.webViews.staticTexts.allElementsBoundByIndex.prefix(12).map(\.label))")
            return
        }
        // 重开 App：启动落在「选择服务」（A7-1，表非空不再自动进）。点那一行进画布——会话从钥匙串
        // 读回，不再问配对。行的名字是那台电脑报的设备名（不再是回环地址，跑在哪台机器上就是哪个名字），
        // 所以按「不是行尾的重命名 / 移除、也不是添加连接」认这一行——表里只有配对的这一台。
        app.terminate()
        app.launch()
        let picker = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", ["选择服务", "Choose a service"])).firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 60), "service picker after relaunch")
        let row = app.webViews.buttons.matching(NSPredicate(
            format: "NOT (label BEGINSWITH %@) AND NOT (label BEGINSWITH %@) AND NOT (label BEGINSWITH %@) AND NOT (label BEGINSWITH %@) AND NOT (label IN %@)",
            "移除", "Remove", "重命名", "Rename", ["添加连接", "Add connection"])).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the paired gateway's row")
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(button(app, ["画布", "Canvas"]).waitForExistence(timeout: 60), "canvas after picking the service")
        XCTAssertFalse(button(app, ["连接", "Connect"]).exists)
        // 原生 OAuth 的深链（R-56）：App 写进 `#link=` 重载，入口收尾（本机没有挂起的流程，答失败、
        // 不发请求），结果打开「账号与安全」页（#205 设置重组后的分区名）；会话不受影响，不回连接页。
        // 浏览器授权完回到的是还在跑的 App：经系统打开（热启动）。
        XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: "armadra://oauth?state=e2e-state&code=e2e-code")))
        confirmOpenIfAsked()
        let security = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", ["账号与安全", "Account & security"])).firstMatch
        XCTAssertTrue(security.waitForExistence(timeout: 60), "security page after the oauth link")
        XCTAssertFalse(button(app, ["连接", "Connect"]).exists)
    }
}
