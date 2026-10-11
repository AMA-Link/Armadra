import ArmadraNativeKit
import Capacitor
import UIKit

extension LaunchLink {
    /// 场景代理记、视图控制器取、插件认（#281）。
    static let shared = LaunchLink()
}

/// 窗口由 `Main.storyboard`（`ArmadraBridgeViewController`）建，这里只把场景事件
/// 交给 Capacitor：深链（`armadra://…`）经它发成 `.capacitorOpenURL`，冷启动时的
/// 那一条在插件装好之后才补发。冷启动的那一条另记进 `LaunchLink`：需要重载的（配对、分享、
/// OAuth 回调）由 `ArmadraBridgeViewController` 直接写进第一个文档，不再载完页面再重载一遍。
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        LaunchLink.shared.record(connectionOptions.urlContexts.map(\.url.absoluteString))
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
