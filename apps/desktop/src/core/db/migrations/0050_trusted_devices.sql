-- 端到端通道的设备钥（契约 §77）：经中继的客户端每台设备持一把 Ed25519 设备钥，
-- 握手里签转录；这里把设备钥绑到本机主体。中继签的断言只负责「这是谁」，设备钥
-- 负责「确实是他的设备」——没有已信任的设备钥，断言换不到会话。
--
--   device_id        设备钥公钥 SHA-256 的前 16 字节（32 位十六进制）。
--   principal_id     绑到的主体；同一把钥可以分别绑到几个主体，各自审批。
--   public_key       Ed25519 公钥原文（32 字节）。
--   status           pending = 等主人在本机核对校验码；trusted；rejected = 主人拒绝；
--                    revoked = 撤销（断通道、吊销经它签的会话）。
--   request_id       待确认记录的标识（`devices.approve` 的 pendingId），每次重新进入待确认时换新。
--   approved_by      local = 本机核对；pairing = 扫码配对；endorse:<deviceId> = 已信任设备背书；
--                    link:<linkId> = 访客链接首次加入。
--   issuer           经哪个远程服务来的；issuer_device_id 是断言里的 device.deviceId（对账用）。
CREATE TABLE trusted_devices (
  device_id TEXT NOT NULL CHECK(length(device_id) = 32),
  principal_id TEXT NOT NULL REFERENCES identity_principals(principal_id),
  public_key BLOB NOT NULL CHECK(length(public_key) = 32),
  label TEXT NOT NULL DEFAULT '' CHECK(length(label) <= 128),
  platform TEXT NOT NULL DEFAULT '' CHECK(length(platform) <= 32),
  status TEXT NOT NULL CHECK(status IN ('pending', 'trusted', 'rejected', 'revoked')),
  request_id TEXT NOT NULL CHECK(length(request_id) = 32),
  approved_by TEXT NOT NULL DEFAULT '' CHECK(length(approved_by) <= 128),
  issuer TEXT NOT NULL DEFAULT '' CHECK(length(issuer) <= 512),
  issuer_device_id TEXT NOT NULL DEFAULT '' CHECK(length(issuer_device_id) <= 128),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
  approved_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(approved_at_ms >= 0),
  last_seen_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_seen_at_ms >= 0),
  revoked_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0),
  PRIMARY KEY (device_id, principal_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX trusted_devices_request ON trusted_devices(request_id);
CREATE INDEX trusted_devices_by_principal ON trusted_devices(principal_id, status);
CREATE INDEX trusted_devices_by_link ON trusted_devices(approved_by) WHERE approved_by LIKE 'link:%';

-- 经端到端通道签的会话绑那条通道的设备钥：通道设备与会话设备不符 → 401。
-- 空串 = 不经通道签的会话（回环、Gateway、过渡期的明文中继）；这样的会话进不了通道。
ALTER TABLE identity_sessions ADD COLUMN channel_device_id TEXT NOT NULL DEFAULT ''
  CHECK(channel_device_id = '' OR length(channel_device_id) = 32);

-- 本机作为客户端时钉住的对端 core 身份公钥（契约 §78，设计 §4.9）：第一次经端到端
-- 通道连上时记下（TOFU），之后变了一律拒绝，由人在设置里「忘记」。空 = 还没钉。
ALTER TABLE client_sources ADD COLUMN identity_pub BLOB NOT NULL DEFAULT x''
  CHECK(length(identity_pub) IN (0, 32));
