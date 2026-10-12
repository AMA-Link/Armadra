-- 流量统计（契约 §76）：经远程服务（中继）收发的字节，按 UTC 小时桶 × 对端 × 类别聚合。
--   route         'relay'（本批只写它）| 'lan'（预留给合一后的 Gateway）。
--   issuer        经哪个远程服务；lan 为空。
--   peer_kind     'device' 已信任的设备钥 | 'legacy' 经断言登录的会话设备 | 'guest' 经分享链接的访客
--                 | 'anonymous' 没认出身份的流 | 'tunnel' 隧道本身（只出现在 transport）。
--   peer_id       对端标识（会话设备 id、日后的设备钥 id）；anonymous / tunnel 为空。
--   principal_id  对端登录成的本机主体；没有为空。
--   link_id       访客经由的分享链接；不是访客为空。
--   category      'transport' 记线上字节（隧道消息载荷），其余记内层流的明文字节。
--   streams       这一桶里开始的内层流条数；transport 行恒为 0。
--   bytes_in      对端 → 本机；bytes_out 本机 → 对端。
-- 不记路径、查询串、头、IP、Origin 与内容。内存累加、批量 upsert；保留期由设置
-- traffic.retentionDays 决定（缺省 180 天）。
CREATE TABLE traffic_buckets (
  bucket_start_ms INTEGER NOT NULL CHECK(bucket_start_ms >= 0 AND bucket_start_ms % 3600000 = 0),
  route TEXT NOT NULL CHECK(route IN ('relay', 'lan')),
  issuer TEXT NOT NULL DEFAULT '' CHECK(length(issuer) <= 512),
  peer_kind TEXT NOT NULL CHECK(peer_kind IN ('device', 'legacy', 'guest', 'anonymous', 'tunnel')),
  peer_id TEXT NOT NULL DEFAULT '' CHECK(length(peer_id) <= 128),
  principal_id TEXT NOT NULL DEFAULT '' CHECK(length(principal_id) <= 128),
  link_id TEXT NOT NULL DEFAULT '' CHECK(length(link_id) <= 128),
  category TEXT NOT NULL
    CHECK(category IN ('transport', 'api', 'terminal', 'events', 'canvas', 'files', 'agent', 'other')),
  streams INTEGER NOT NULL DEFAULT 0 CHECK(streams >= 0),
  bytes_in INTEGER NOT NULL DEFAULT 0 CHECK(bytes_in >= 0),
  bytes_out INTEGER NOT NULL DEFAULT 0 CHECK(bytes_out >= 0),
  PRIMARY KEY (bucket_start_ms, route, issuer, peer_kind, peer_id, principal_id, link_id, category)
) WITHOUT ROWID;

CREATE INDEX traffic_buckets_peer ON traffic_buckets(peer_id, bucket_start_ms);
CREATE INDEX traffic_buckets_time ON traffic_buckets(bucket_start_ms);
