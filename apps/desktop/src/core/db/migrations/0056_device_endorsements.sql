-- 设备背书的通知（契约 §81.1）：每次 `approved_by = endorse:*` 的放行在主机上记一行，主人没看过之前
-- 进「需要人处理」（铃铛、通知面板），看过之后标已读。这是主人事后发现「别的设备替人背书」的凭据，
-- 所以名字在背书那一刻抄下来：之后设备被改名、删掉，这一行仍说得清当时放行的是什么。
--
--   id                    这一行的标识（32 位十六进制）。
--   device_id             被放行的设备钥（`trusted_devices.device_id`）。
--   principal_id          被放行的设备绑到的主体。
--   principal_name        当时主体的显示名。
--   device_label          当时设备的名字；device_platform 是它登记的平台。
--   endorser_device_id    背书的那台受信设备（`endorse:` 之后的部分）。
--   endorser_principal_id 背书人；endorser_label 是当时背书设备的名字（查不到是空串）。
--   read_at_ms            主人标已读的时刻；0 = 未读。
CREATE TABLE device_endorsements (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  device_id TEXT NOT NULL CHECK(length(device_id) BETWEEN 1 AND 64),
  principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 128),
  principal_name TEXT NOT NULL DEFAULT '' CHECK(length(principal_name) <= 128),
  device_label TEXT NOT NULL DEFAULT '' CHECK(length(device_label) <= 128),
  device_platform TEXT NOT NULL DEFAULT '' CHECK(length(device_platform) <= 32),
  endorser_device_id TEXT NOT NULL CHECK(length(endorser_device_id) BETWEEN 1 AND 64),
  endorser_principal_id TEXT NOT NULL DEFAULT '' CHECK(length(endorser_principal_id) <= 128),
  endorser_label TEXT NOT NULL DEFAULT '' CHECK(length(endorser_label) <= 128),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
  read_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(read_at_ms >= 0)
) WITHOUT ROWID;

CREATE INDEX device_endorsements_unread ON device_endorsements(created_at_ms) WHERE read_at_ms = 0;
