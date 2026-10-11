import ArmadraNativeKit
import XCTest

final class DeepLinkTests: XCTestCase {
    func testClassifiesTheTwoKinds() {
        let pair = "armadra://pair?host=192.168.1.20%3A8443&ticket=abc_DEF-123&fp=" + String(repeating: "a", count: 64)
        XCTAssertEqual(DeepLink(pair), .pair(pair))
        XCTAssertEqual(DeepLink("armadra://w/ws_1/n/node_1"), .node("armadra://w/ws_1/n/node_1"))
        XCTAssertEqual(DeepLink("armadra://w/ws_1"), .node("armadra://w/ws_1"))
        XCTAssertNil(DeepLink("armadra://w/ws_1/x/y"))
        // 签发它的主机（契约 §19.4）；别的查询串不认。
        XCTAssertEqual(DeepLink("armadra://w/ws_1/n/node_1?s=host%3A1"), .node("armadra://w/ws_1/n/node_1?s=host%3A1"))
        XCTAssertEqual(DeepLink("armadra://w/ws_1?s=h"), .node("armadra://w/ws_1?s=h"))
        XCTAssertNil(DeepLink("armadra://w/ws_1?x=h"))
        XCTAssertNil(DeepLink("armadra://w/ws_1?s=h&x=1"))
        XCTAssertNil(DeepLink("https://armadra.dev/pair"))
        XCTAssertNil(DeepLink("armadra://pair?host=a&x=<script>"))
        XCTAssertNil(DeepLink("armadra://w/" + String(repeating: "a", count: 3000)))
    }

    func testJoinLinksReloadLikePairing() {
        let link = "armadra://join?link=" + String(repeating: "0", count: 32)
            + "&issuer=https%3A%2F%2Frelay.example.com&s=" + String(repeating: "S", count: 43) + "." + String(repeating: "c", count: 32) + "." + String(repeating: "D", count: 43)
        XCTAssertEqual(DeepLink(link), .join(link))
        XCTAssertEqual(DeepLink(link)?.link, link)
        let script = DeepLink(link)!.script
        XCTAssertTrue(script.hasPrefix("history.replaceState(null,'',location.pathname+'#link='+encodeURIComponent("))
        XCTAssertTrue(script.hasSuffix("location.reload();"))
        XCTAssertNil(DeepLink("armadra://join"))
        XCTAssertNil(DeepLink("armadra://join?link=a'+alert(1)+'"))
        XCTAssertNil(DeepLink("armadra://joinx?link=a"))
    }

    func testScriptsQuoteTheLinkAsAStringLiteral() {
        XCTAssertEqual(
            DeepLink("armadra://w/ws_1/n/node_1")?.script,
            #"location.hash='#push='+encodeURIComponent("armadra:\/\/w\/ws_1\/n\/node_1");"#
        )
        let pair = DeepLink("armadra://pair?host=h%3A1&ticket=t&fp=f")!.script
        XCTAssertTrue(pair.hasPrefix("history.replaceState(null,'',location.pathname+'#link='+encodeURIComponent("))
        XCTAssertTrue(pair.hasSuffix("location.reload();"))
        // 一个 `'` 都拼不进去：认不出的字符在分类时就挡掉了。
        XCTAssertNil(DeepLink("armadra://w/a'+alert(1)+'"))
    }

    func testOAuthCallbacksReloadLikePairing() {
        let link = "armadra://oauth?state=s_T-1&code=a*b.c%2Fd"
        XCTAssertEqual(DeepLink(link), .oauth(link))
        XCTAssertEqual(DeepLink("armadra://oauth?state=s&error=access_denied")?.link, "armadra://oauth?state=s&error=access_denied")
        let script = DeepLink(link)!.script
        XCTAssertTrue(script.hasPrefix("history.replaceState(null,'',location.pathname+'#link='+encodeURIComponent("))
        XCTAssertTrue(script.hasSuffix("location.reload();"))
        XCTAssertNil(DeepLink("armadra://oauth"))
        XCTAssertNil(DeepLink("armadra://oauth?state=a'+alert(1)+'"))
        XCTAssertNil(DeepLink("armadra://oauthx?state=a"))
    }
}

/// 冷启动的深链写进第一个文档，不再载完重载（#281）。
final class LaunchLinkTests: XCTestCase {
    private let pair = "armadra://pair?host=127.0.0.1%3A9&ticket=t&fp=f"

    func testOnlyLinksThatReloadGetALaunchScript() {
        XCTAssertTrue(DeepLink(pair)!.reloadsPage)
        XCTAssertTrue(DeepLink("armadra://oauth?state=s&code=c")!.reloadsPage)
        XCTAssertFalse(DeepLink("armadra://w/ws_1")!.reloadsPage)
        XCTAssertNil(DeepLink("armadra://w/ws_1")!.launchScript(token: "x"))
        let script = DeepLink(pair)!.launchScript(token: "tok")!
        // 只写地址片段、不重载；同一个 token 已记过就什么也不做。
        XCTAssertFalse(script.contains("reload"))
        XCTAssertTrue(script.contains(#"sessionStorage.getItem("armadra.launchLink")!=="tok""#))
        XCTAssertTrue(script.contains(#"'#link='+encodeURIComponent("armadra:\/\/pair?host=127.0.0.1%3A9&ticket=t&fp=f")"#))
    }

    func testTheInjectedLinkIsConsumedOnce() {
        let slot = LaunchLink()
        slot.record(["https://example.com", pair])
        XCTAssertNotNil(slot.take(token: "tok"))
        XCTAssertNil(slot.take(token: "tok"), "taken once")
        // Capacitor 在 viewDidAppear 补发同一条：认出来、不再重载；之后再来同一条（人又点了一次）照常处理。
        XCTAssertFalse(slot.consume("armadra://pair?host=other&ticket=t&fp=f"))
        XCTAssertTrue(slot.consume(pair))
        XCTAssertFalse(slot.consume(pair))
    }

    func testNotificationLinksAndEmptyLaunchesInjectNothing() {
        let slot = LaunchLink()
        XCTAssertNil(slot.take())
        slot.record(["armadra://w/ws_1/n/node_1"])
        XCTAssertNil(slot.take())
        XCTAssertFalse(slot.consume("armadra://w/ws_1/n/node_1"))
    }
}
