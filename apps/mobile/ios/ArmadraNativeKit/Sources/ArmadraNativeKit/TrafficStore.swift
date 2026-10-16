import Foundation

/// 客户端流量日桶的校验与持久化（与页面 `native-bridge.ts` 的 `NativeTrafficRow`、Android
/// `TrafficRows.java` 同义，设计 §6.4）。一行是「本地日 × 源 × 类别」的收发字节；页面整份交来、
/// 整份读走。形状或上限不对整份拒绝，免得半份坏数据盖掉历史。
public enum TrafficRows {
    public static let maxRows = 20_000
    private static let maxCount = 9_007_199_254_740_991.0  // 2^53 - 1，页面的整数上限

    public static func valid(
        day: String, sourceId: String, category: String,
        bytesIn: Double, bytesOut: Double, streams: Double
    ) -> Bool {
        guard day.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil,
              sourceId.range(of: #"^[A-Za-z0-9._:-]{1,128}$"#, options: .regularExpression) != nil,
              (1...32).contains(category.count)
        else { return false }
        return [bytesIn, bytesOut, streams].allSatisfy { $0.isFinite && $0 >= 0 && $0 <= maxCount }
    }

    /// 通过校验的行（原样）；任何一行不对、或超过上限是 `nil`。
    public static func checked(_ rows: [[String: Any]]) -> [[String: Any]]? {
        guard rows.count <= maxRows else { return nil }
        for row in rows {
            guard let day = row["day"] as? String,
                  let sourceId = row["sourceId"] as? String,
                  let category = row["category"] as? String,
                  let bytesIn = (row["bytesIn"] as? NSNumber)?.doubleValue,
                  let bytesOut = (row["bytesOut"] as? NSNumber)?.doubleValue,
                  let streams = (row["streams"] as? NSNumber)?.doubleValue,
                  valid(day: day, sourceId: sourceId, category: category,
                        bytesIn: bytesIn, bytesOut: bytesOut, streams: streams)
            else { return nil }
        }
        return rows
    }
}

/// 日桶存在 `UserDefaults`（Capacitor Preferences 同一个后端）：一个 JSON 字符串。不放钥匙串——
/// 不是秘密，也不该随钥匙串的「重装后还在」留下上一次安装的数。
public struct TrafficStore {
    public static let defaultKey = "dev.armadra.mobile.traffic"
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = TrafficStore.defaultKey) {
        self.defaults = defaults
        self.key = key
    }

    /// 读出全部日桶；没有或坏了是空（页面把「读失败」当作原生没答，空数组就是「还没有」）。
    public func load() -> [[String: Any]] {
        guard let text = defaults.string(forKey: key),
              let data = text.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let rows = TrafficRows.checked(parsed)
        else { return [] }
        return rows
    }

    /// 整份替换；校验不过、序列化失败返回 `false`，原来的不动。
    @discardableResult
    public func save(_ rows: [[String: Any]]) -> Bool {
        guard let rows = TrafficRows.checked(rows),
              let data = try? JSONSerialization.data(withJSONObject: rows),
              let text = String(data: data, encoding: .utf8)
        else { return false }
        defaults.set(text, forKey: key)
        return true
    }
}
