import Foundation

/// 冷启动带来的深链（`scene(_:willConnectTo:options:)` 的 `urlContexts`）。
///
/// 场景代理先把它记下；Capacitor 的视图控制器在第一次载入页面之前（`capacitorDidLoad`）取走，
/// 需要重载才生效的那三种直接写进第一个文档的 `#link=`（`DeepLink.launchScript`）。Capacitor
/// 之后还会在第一次 `viewDidAppear` 把同一条照常补发，插件经 `consume` 认出它、不再改写地址
/// 重载——否则冷启动要载两遍页面，第二遍打断第一遍的启动（#281）。
///
/// 场景先于视图载入是 UIKit 用 storyboard 建窗口时的顺序；万一视图先载入，`take` 什么也拿不到，
/// 插件照旧等页面载完再改写重载，不丢链接。
public final class LaunchLink {
    private var pending: [String] = []
    private var delivered: String?

    public init() {}

    /// 场景连上时调用：记下带来的链接（可能为空）。
    public func record(_ links: [String]) {
        pending = links
    }

    /// 视图第一次载入页面之前调用：拿到要装进第一个文档的脚本，没有就是 `nil`。只取一次。
    public func take(token: String = UUID().uuidString) -> String? {
        defer { pending = [] }
        for link in pending {
            if let deepLink = DeepLink(link), let script = deepLink.launchScript(token: token) {
                delivered = deepLink.link
                return script
            }
        }
        return nil
    }

    /// 插件收到深链时先问一声：是已经写进第一个文档的那一条就答 `true`（只认一次）。
    public func consume(_ link: String) -> Bool {
        guard let delivered, delivered == link else { return false }
        self.delivered = nil
        return true
    }
}
